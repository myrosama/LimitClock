function fmtNum(n) {
  return n.toLocaleString("en-US");
}

function fmtTime(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function progressBar(pct, len = 20) {
  const filled = Math.round((pct / 100) * len);
  return "▓".repeat(filled) + "░".repeat(len - filled);
}

function getMinsUntilReset(state) {
  if (!state.resetTime || state.resetTime <= Date.now()) return null;
  return Math.max(0, (state.resetTime - Date.now()) / 60_000);
}

function percentWindowElapsed(state) {
  if (!state.stats || state.stats.windowStartMs === 0) return 100;
  const elapsed = Date.now() - state.stats.windowStartMs;
  return Math.min(100, Math.max(0, (elapsed / (5 * 3600_000)) * 100));
}

function msgStatus(state) {
  const stats = state.stats;
  if (!stats) return "No stats synced yet. Run the local LimitClock sync script.";
  
  const pct = percentWindowElapsed(state);
  const mins = getMinsUntilReset(state);
  const bar = progressBar(pct);

  const lines = [
    `🕐 *LimitClock Status* (Cloud)`,
    ``,
    `\`${bar}\` ${pct.toFixed(0)}% window elapsed`,
    `📊 Tokens in window: *${fmtNum(stats.windowTokens)}*`,
  ];

  if (mins !== null && mins > 0) {
    if (state.explicitLimitStr) {
      lines.push(`⏳ Next token release: *${state.explicitLimitStr}* (in ${fmtTime(mins)})`);
    } else {
      lines.push(`⏳ Next token release: *${fmtTime(mins)}*`);
    }
  } else {
    lines.push(`🟢 Window is clear — no active limits`);
  }

  return lines.join("\n");
}

function msgStats(state) {
  const stats = state.stats;
  if (!stats) return "No stats synced yet.";
  
  const modelLines = Object.entries(stats.models)
    .sort((a, b) => b[1] - a[1])
    .map(([m, t]) => `  • \`${m}\`: ${fmtNum(t)}`)
    .join("\n");

  const mins = getMinsUntilReset(state);
  let rateLine;
  if (mins !== null && mins > 0) {
    rateLine = state.explicitLimitStr 
      ? `⏳ Next release: *${state.explicitLimitStr}*`
      : `⏳ Next release: *${fmtTime(mins)}*`;
  } else {
    rateLine = `🟢 No active rate limit`;
  }

  return [
    `📊 *LimitClock Stats*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🔢 Total: *${fmtNum(stats.totalTokens)}* tokens`,
    `📥 In: ${fmtNum(stats.totalIn)} │ 📤 Out: ${fmtNum(stats.totalOut)}`,
    `💾 Cache W: ${fmtNum(stats.totalCacheW)} │ 📖 Cache R: ${fmtNum(stats.totalCacheR)}`,
    ``,
    `🤖 API calls: *${fmtNum(stats.apiCalls)}*`,
    ``,
    `📈 *Models:*`,
    modelLines,
    ``,
    `⚡ Last hour: ${fmtNum(stats.lastHour)} tokens`,
    `📅 Last 24h: ${fmtNum(stats.last24h)} tokens`,
    `🏆 Peak hour: ${String(stats.peakHour).padStart(2, "0")}:00`,
    `📚 ≈ ${stats.booksEquiv.toFixed(1)} novels worth of text`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    rateLine,
  ].join("\n");
}

function msgWhen(state) {
  const stats = state.stats;
  if (!stats) return "No stats synced yet.";
  
  const mins = getMinsUntilReset(state);
  if (mins === null || mins <= 0) {
    return `🟢 Window is clear! No tokens pending reset.`;
  } else {
    const tokensToFree = state.explicitLimitStr ? "Full reset" : `~${fmtNum(stats.tokensToFree)}`;
    const resetDate = new Date(state.resetTime);
    return [
      `⏰ *Next Token Release*`,
      ``,
      `⏳ In: *${fmtTime(mins)}*`,
      `🕐 At: \`${state.explicitLimitStr || resetDate.toISOString().slice(11, 16) + ' UTC'}\``,
      `🔓 Tokens: ${tokensToFree}`,
    ].join("\n");
  }
}

async function sendTelegramMsg(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. Local Sync Endpoint
    if (request.method === "POST" && url.pathname === "/sync") {
      try {
        const data = await request.json();
        await env.LIMITCLOCK_KV.put("timer_state", JSON.stringify({
          resetTime: data.resetTime, // epoch ms
          explicitLimitStr: data.explicitLimitStr,
          chatId: data.chatId,
          botToken: data.botToken,
          stats: data.stats,
          notified: data.resetTime === 0 // if 0, nothing to notify
        }));
        return new Response("State synced successfully", { status: 200 });
      } catch (e) {
        return new Response(e.message, { status: 500 });
      }
    }
    
    // 2. Telegram Webhook Endpoint
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          const text = update.message.text;
          const chatId = update.message.chat.id;
          
          const stateStr = await env.LIMITCLOCK_KV.get("timer_state");
          if (!stateStr) return new Response("OK", { status: 200 });
          const state = JSON.parse(stateStr);
          
          // Verify it's the authorized user
          if (String(chatId) !== String(state.chatId)) return new Response("OK", { status: 200 });

          let responseText = null;
          if (text.startsWith("/start") || text.startsWith("/help")) {
            responseText = `🕐 *LimitClock (Cloud Mode)*\n\n/status — Rate limit status\n/stats — Full usage statistics\n/when — Time until next reset\n/chatid — Show your chat ID`;
          } else if (text.startsWith("/status")) {
            responseText = msgStatus(state);
          } else if (text.startsWith("/stats")) {
            responseText = msgStats(state);
          } else if (text.startsWith("/when")) {
            responseText = msgWhen(state);
          } else if (text.startsWith("/chatid")) {
            responseText = `Your chat ID: \`${chatId}\``;
          }
          
          if (responseText) {
            await sendTelegramMsg(state.botToken, chatId, responseText);
          }
        }
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(e.message, { status: 500 });
      }
    }
    
    return new Response("LimitClock Worker is active.");
  },

  async scheduled(event, env, ctx) {
    const stateStr = await env.LIMITCLOCK_KV.get("timer_state");
    if (!stateStr) return;
    
    const state = JSON.parse(stateStr);
    
    if (!state.notified && state.resetTime > 0 && Date.now() >= state.resetTime) {
      await sendTelegramMsg(state.botToken, state.chatId, `🟢 *Claude Code Limit Reset!*\n\nYour rate limit window has rolled over.\n\nGo build something amazing! 🚀`);
      
      state.notified = true;
      state.resetTime = 0; // reset
      await env.LIMITCLOCK_KV.put("timer_state", JSON.stringify(state));
    }
  }
};
