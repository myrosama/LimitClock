#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const WORKER_URL = "https://limitclock-worker.sadrikov49.workers.dev/sync";
const WINDOW_HOURS = 5;

let explicitLimitStr = null;
let explicitLimitDate = null;

function parseLimitString(str) {
  const m = str.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let [_, h, min, ampm] = m;
  h = parseInt(h);
  min = parseInt(min);
  if (ampm && ampm.toLowerCase() === "pm" && h < 12) h += 12;
  if (ampm && ampm.toLowerCase() === "am" && h === 12) h = 0;
  
  const now = new Date();
  const resetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0);
  
  if (resetDate.getTime() < now.getTime() - 3600_000) {
    resetDate.setDate(resetDate.getDate() + 1);
  }
  return resetDate;
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

function billableTokens(usage) {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreation;
}

function totalAllTokens(usages) {
  return usages.reduce(
    (sum, u) =>
      sum + u.inputTokens + u.outputTokens + u.cacheCreation + u.cacheRead,
    0
  );
}

function parseAllUsages() {
  const usages = [];
  if (!fs.existsSync(PROJECTS_DIR)) return usages;

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, dir.name);

    const files = findJsonlFiles(projectPath);
    for (const file of files) {
      if (file.includes("subagents")) continue;
      try {
        const content = fs.readFileSync(file, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            
            if (entry.error === "rate_limit" && entry.isApiErrorMessage && entry.message?.content) {
              const text = entry.message.content.find(c => c.type === "text")?.text;
              if (text && text.includes("resets ")) {
                const match = text.match(/resets\s+(.*?)$/);
                if (match) {
                  const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
                  if (ts >= Date.now() - 24 * 3600_000) {
                    explicitLimitStr = match[1].trim();
                    explicitLimitDate = parseLimitString(explicitLimitStr);
                  }
                }
              }
            }

            if (entry.type === "assistant" && entry.message?.usage) {
              const u = entry.message.usage;
              const ts = entry.timestamp ? new Date(entry.timestamp) : null;
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

function computeStats(allUsages) {
  const cutoff = new Date(Date.now() - WINDOW_HOURS * 3600_000);
  const windowUsages = allUsages.filter((u) => u.timestamp >= cutoff);
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
    
  const windowTokens = windowUsages.reduce((sum, u) => sum + billableTokens(u), 0);
  const tokensToFree = windowUsages.length > 0 ? billableTokens(windowUsages[0]) : 0;
  const windowStartMs = windowUsages.length > 0 ? windowUsages[0].timestamp.getTime() : 0;

  return {
    totalTokens: totalAllTokens(allUsages),
    totalIn, totalOut, totalCacheW, totalCacheR,
    apiCalls: allUsages.length,
    models,
    lastHour, last24h,
    peakHour,
    booksEquiv: totalAllTokens(allUsages) / 100_000,
    windowTokens,
    tokensToFree,
    windowStartMs
  };
}

async function sync() {
  console.log("🔄 Reading Claude Code sessions...");
  const usages = parseAllUsages();
  const stats = computeStats(usages);
  
  let resetTime = null;
  let resetReason = "";
  
  if (explicitLimitDate) {
    resetTime = explicitLimitDate.getTime();
    resetReason = `Explicit limit (${explicitLimitStr})`;
  } else if (stats.windowStartMs > 0) {
    // Math-based 5-hour window
    resetTime = stats.windowStartMs + WINDOW_HOURS * 3600_000;
    resetReason = "Rolling 5-hour window";
  }
  
  if (!resetTime || resetTime <= Date.now()) {
    console.log("🟢 No active limits. Syncing clean state to cloud...");
    resetTime = 0;
  } else {
    const diffMins = Math.max(0, (resetTime - Date.now()) / 60_000);
    console.log(`⏰ Found active limit: ${resetReason}`);
    console.log(`⏳ Reset in: ${Math.round(diffMins)} minutes`);
  }
  
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.error("❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
    return;
  }

  console.log("☁️  Syncing with Cloudflare Worker...");
  try {
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resetTime: resetTime,
        explicitLimitStr: explicitLimitStr,
        chatId: process.env.TELEGRAM_CHAT_ID,
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        stats: stats
      })
    });
    
    if (res.ok) {
      console.log("✅ State securely stored in the cloud!");
      console.log("💻 Telegram bot can now reply to your commands even while your laptop is off!");
    } else {
      console.error("❌ Worker Error:", await res.text());
    }
  } catch (err) {
    console.error("❌ Failed to reach Cloudflare Worker:", err.message);
  }
}

sync();
