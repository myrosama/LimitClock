require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const TelegramBot = require("node-telegram-bot-api");
const chokidar = require("chokidar");

// ── Config ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
const WINDOW_HOURS = 5; // Claude Code's rolling rate-limit window
const POLL_INTERVAL = 30_000; // Check every 30 seconds
const NOTIFY_COOLDOWN = 5 * 60_000; // Don't spam — 5 min cooldown between notifications

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🕐 LimitClock started");

// ── State ───────────────────────────────────────────────────────────────────
let lastNotifyTime = 0;
let scheduledResetTimer = null;
let wasLimited = false; // track if user was previously rate-limited
let lastKnownUsages = []; // cached parsed usages

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse all JSONL session files and extract token usage entries with timestamps.
 * Returns: [{ inputTokens, outputTokens, cacheCreation, cacheRead, timestamp, model }]
 */
function parseAllUsages() {
  const usages = [];
  if (!fs.existsSync(PROJECTS_DIR)) return usages;

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, dir.name);

    // Find all .jsonl files (skip subagents/)
    const files = findJsonlFiles(projectPath);
    for (const file of files) {
      if (file.includes("subagents")) continue;
      try {
        const content = fs.readFileSync(file, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "assistant" && entry.message?.usage) {
              const u = entry.message.usage;
              const ts = entry.timestamp
                ? new Date(entry.timestamp)
                : null;
              if (ts && !isNaN(ts.getTime())) {
                usages.push({
                  inputTokens: u.input_tokens || 0,
                  outputTokens: u.output_tokens || 0,
                  cacheCreation: u.cache_creation_input_tokens || 0,
                  cacheRead: u.cache_read_input_tokens || 0,
                  timestamp: ts,
                  model: entry.message.model || entry.model || "unknown",
                });
              }
            }
          } catch {}
        }
      } catch {}
    }
  }

  usages.sort((a, b) => a.timestamp - b.timestamp);
  return usages;
}

function findJsonlFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "subagents") {
        results.push(...findJsonlFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

/** Get usages within the rolling 5h window */
function getWindowUsages(allUsages) {
  const cutoff = new Date(Date.now() - WINDOW_HOURS * 3600_000);
  return allUsages.filter((u) => u.timestamp >= cutoff);
}

/** Calculate total billable tokens (input + output + cache creation) */
function billableTokens(usage) {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreation;
}

function totalBillable(usages) {
  return usages.reduce((sum, u) => sum + billableTokens(u), 0);
}

function totalAllTokens(usages) {
  return usages.reduce(
    (sum, u) =>
      sum + u.inputTokens + u.outputTokens + u.cacheCreation + u.cacheRead,
    0
  );
}

/** When will the oldest token in the window expire? */
function nextResetTime(windowUsages) {
  if (windowUsages.length === 0) return null;
  const oldest = windowUsages[0].timestamp;
  return new Date(oldest.getTime() + WINDOW_HOURS * 3600_000);
}

/** Minutes until the oldest tokens free up */
function minutesUntilReset(windowUsages) {
  const reset = nextResetTime(windowUsages);
  if (!reset) return null;
  const diff = (reset - Date.now()) / 60_000;
  return Math.max(0, diff);
}

function percentWindowElapsed(windowUsages) {
  if (windowUsages.length === 0) return 100;
  const oldest = windowUsages[0].timestamp;
  const windowMs = WINDOW_HOURS * 3600_000;
  const elapsed = Date.now() - oldest.getTime();
  return Math.min(100, Math.max(0, (elapsed / windowMs) * 100));
}

/** Get info about the currently active Claude Code session */
function getActiveSession() {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    let latest = null;
    for (const file of files) {
      const data = JSON.parse(
        fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8")
      );
      if (
        data.status === "running" ||
        data.status === "waiting"
      ) {
        if (!latest || (data.startedAt && data.startedAt > (latest.startedAt || 0))) {
          latest = data;
        }
      }
    }
    return latest;
  } catch {
    return null;
  }
}

/** Aggregate stats */
function computeStats(allUsages) {
  const windowUsages = getWindowUsages(allUsages);
  const hourAgo = new Date(Date.now() - 3600_000);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);

  const models = {};
  let totalIn = 0, totalOut = 0, totalCacheW = 0, totalCacheR = 0;
  let lastHour = 0, last24h = 0;
  const hourlyBuckets = {};

  for (const u of allUsages) {
    totalIn += u.inputTokens;
    totalOut += u.outputTokens;
    totalCacheW += u.cacheCreation;
    totalCacheR += u.cacheRead;
    models[u.model] = (models[u.model] || 0) + billableTokens(u);
    const h = u.timestamp.getUTCHours();
    hourlyBuckets[h] = (hourlyBuckets[h] || 0) + billableTokens(u);
    if (u.timestamp >= hourAgo) lastHour += billableTokens(u);
    if (u.timestamp >= dayAgo) last24h += billableTokens(u);
  }

  const peakHour = Object.keys(hourlyBuckets).length
    ? +Object.entries(hourlyBuckets).sort((a, b) => b[1] - a[1])[0][0]
    : 0;

  return {
    totalTokens: totalAllTokens(allUsages),
    totalIn, totalOut, totalCacheW, totalCacheR,
    apiCalls: allUsages.length,
    models,
    lastHour, last24h,
    peakHour,
    booksEquiv: totalAllTokens(allUsages) / 100_000,
    windowTokens: totalBillable(windowUsages),
    windowUsages,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

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

// ── Telegram Messages ───────────────────────────────────────────────────────

function msgReset(tokenCount) {
  return [
    `🟢 *Claude Code Limit Reset!*`,
    ``,
    `Your rate limit window has rolled over.`,
    `🎉 *${fmtNum(tokenCount)}* tokens freed up!`,
    ``,
    `Go build something amazing! 🚀`,
  ].join("\n");
}

function msgResetSoon(mins, tokenCount) {
  return [
    `⏰ *Limit Reset Incoming!*`,
    ``,
    `⏳ Tokens free in: *${fmtTime(mins)}*`,
    `🔓 Tokens to free: *${fmtNum(tokenCount)}*`,
    ``,
    `Hang tight! ☕`,
  ].join("\n");
}

function msgStatus(stats) {
  const wu = stats.windowUsages;
  const pct = percentWindowElapsed(wu);
  const mins = minutesUntilReset(wu);
  const bar = progressBar(pct);

  const lines = [
    `🕐 *LimitClock Status*`,
    ``,
    `\`${bar}\` ${pct.toFixed(0)}% window elapsed`,
    `📊 Tokens in window: *${fmtNum(stats.windowTokens)}*`,
  ];

  if (mins !== null && mins > 0) {
    lines.push(`⏳ Next token release: *${fmtTime(mins)}*`);
  } else {
    lines.push(`🟢 Window is clear — no active limits`);
  }

  const active = getActiveSession();
  if (active) {
    lines.push(``, `🔵 Active session: \`${active.sessionId?.slice(0, 8) || "?"}\``);
    if (active.version) lines.push(`   v${active.version}`);
  }

  return lines.join("\n");
}

function msgStats(stats) {
  const modelLines = Object.entries(stats.models)
    .sort((a, b) => b[1] - a[1])
    .map(([m, t]) => `  • \`${m}\`: ${fmtNum(t)}`)
    .join("\n");

  const wu = stats.windowUsages;
  const mins = minutesUntilReset(wu);
  const rateLine =
    mins !== null && mins > 0
      ? `⏳ Next release: *${fmtTime(mins)}*`
      : `🟢 No active rate limit`;

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

// ── Bot Commands ────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      `🕐 *LimitClock*`,
      ``,
      `I watch your Claude Code usage and ping you when your rate limit resets.`,
      ``,
      `/status — Rate limit status`,
      `/stats — Full usage statistics`,
      `/when — Time until next reset`,
      `/help — This message`,
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      `🕐 *LimitClock Commands*`,
      ``,
      `/status — Quick rate limit overview`,
      `/stats — Detailed usage breakdown`,
      `/when — Countdown to next token release`,
      `/chatid — Show your chat ID`,
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, (msg) => {
  const usages = parseAllUsages();
  const stats = computeStats(usages);
  bot.sendMessage(msg.chat.id, msgStatus(stats), { parse_mode: "Markdown" });
});

bot.onText(/\/stats/, (msg) => {
  const usages = parseAllUsages();
  const stats = computeStats(usages);
  bot.sendMessage(msg.chat.id, msgStats(stats), { parse_mode: "Markdown" });
});

bot.onText(/\/when/, (msg) => {
  const usages = parseAllUsages();
  const wu = getWindowUsages(usages);
  const mins = minutesUntilReset(wu);

  if (mins === null || mins <= 0) {
    bot.sendMessage(msg.chat.id, `🟢 Window is clear! No tokens pending reset.`);
  } else {
    const reset = nextResetTime(wu);
    const tokensToFree = billableTokens(wu[0]);
    bot.sendMessage(
      msg.chat.id,
      [
        `⏰ *Next Token Release*`,
        ``,
        `⏳ In: *${fmtTime(mins)}*`,
        `🕐 At: \`${reset.toISOString().slice(11, 16)} UTC\``,
        `🔓 Tokens: ~${fmtNum(tokensToFree)}`,
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  }
});

bot.onText(/\/chatid/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your chat ID: \`${msg.chat.id}\``, {
    parse_mode: "Markdown",
  });
});

// ── Background Watcher ──────────────────────────────────────────────────────

/**
 * Main monitoring loop:
 * 1. Parse session files for token usage
 * 2. Check the rolling 5h window
 * 3. If tokens are about to free up soon, schedule a notification
 * 4. Detect when user was rate-limited and notify on reset
 */
function monitor() {
  const allUsages = parseAllUsages();
  lastKnownUsages = allUsages;
  const windowUsages = getWindowUsages(allUsages);

  if (windowUsages.length === 0) return;

  const mins = minutesUntilReset(windowUsages);
  if (mins === null) return;

  // Schedule a notification for when the oldest tokens expire
  if (scheduledResetTimer) clearTimeout(scheduledResetTimer);

  if (mins > 0 && mins <= 300) {
    // Schedule notification at reset time
    const msUntil = mins * 60_000;
    console.log(`⏰ Scheduling reset notification in ${fmtTime(mins)}`);

    scheduledResetTimer = setTimeout(() => {
      const now = Date.now();
      if (now - lastNotifyTime < NOTIFY_COOLDOWN) return;
      lastNotifyTime = now;

      const tokensFreed = billableTokens(windowUsages[0]);
      sendNotification(msgReset(tokensFreed));
    }, msUntil);
  }
}

function sendNotification(text) {
  bot
    .sendMessage(CHAT_ID, text, { parse_mode: "Markdown" })
    .then(() => console.log("📨 Notification sent"))
    .catch((err) => console.error("❌ Failed to send:", err.message));
}

// Start polling loop
setInterval(monitor, POLL_INTERVAL);
monitor(); // Run immediately

// Watch for file changes (new session data written)
if (fs.existsSync(PROJECTS_DIR)) {
  const watcher = chokidar.watch(PROJECTS_DIR, {
    ignoreInitial: true,
    depth: 3,
    awaitWriteFinish: { stabilityThreshold: 1000 },
  });
  watcher.on("change", () => {
    console.log("📝 Session data changed, re-checking...");
    monitor();
  });
  console.log(`👀 Watching ${PROJECTS_DIR}`);
}

// Startup notification
sendNotification(
  [
    `🕐 *LimitClock Online!*`,
    ``,
    `Monitoring your Claude Code usage.`,
    `I'll ping you when tokens free up.`,
    ``,
    `Send /status for a quick check.`,
  ].join("\n")
);

console.log("✅ Bot running. Ctrl+C to stop.");
