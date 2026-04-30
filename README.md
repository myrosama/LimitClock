<p align="center">
  <img src="banner.png" alt="LimitClock" width="600">
</p>

<p align="center">
  <strong>Get notified on Telegram when your Claude Code rate limit resets.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#commands">Commands</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#run-as-service">Run as Service</a> •
  <a href="#license">License</a>
</p>

---

## What is this?

Claude Code has a **rolling 5-hour rate limit window**. When you hit it, you're stuck waiting — but you don't know exactly *when* tokens free up.

**LimitClock** watches your local Claude Code session files and sends you a Telegram notification the moment your tokens reset. No more refreshing, no more guessing.

## Quick Start

### 1. Create a Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the **bot token**

### 2. Get Your Chat ID

1. Open [@userinfobot](https://t.me/userinfobot) on Telegram
2. Send `/start`
3. Copy your **chat ID**

### 3. Install & Run

```bash
# Clone
git clone https://github.com/myrosama/LimitClock.git
cd limitclock

# Install deps
npm install

# Configure
cp .env.example .env
# Edit .env with your bot token and chat ID

# Run
npm start
```

Or use the one-liner:
```bash
curl -fsSL https://raw.githubusercontent.com/myrosama/LimitClock/main/install.sh | bash
```

## Commands

| Command | Description |
|---------|-------------|
| `/status` | Quick rate limit overview with progress bar |
| `/stats` | Full usage breakdown — tokens, models, peak hours |
| `/when` | Exact countdown to next token release |
| `/chatid` | Show your Telegram chat ID |
| `/help` | List all commands |

### Example Messages

**Status Check:**
```
🕐 LimitClock Status

▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░ 62% window elapsed
📊 Tokens in window: 847,293
⏳ Next token release: 1h 54m
```

**Limit Reset Notification:**
```
🟢 Claude Code Limit Reset!

Your rate limit window has rolled over.
🎉 25,398 tokens freed up!

Go build something amazing! 🚀
```

**Full Stats:**
```
📊 LimitClock Stats
━━━━━━━━━━━━━━━━━━━━━━

🔢 Total: 2,847,293 tokens
📥 In: 1,203,847 │ 📤 Out: 394,221
💾 Cache W: 847,293 │ 📖 Cache R: 401,932

🤖 API calls: 1,247

📈 Models:
  • claude-sonnet-4-20250514: 1,847,293
  • claude-opus-4-20250414: 1,000,000

⚡ Last hour: 23,847 tokens
📅 Last 24h: 394,221 tokens
🏆 Peak hour: 14:00
📚 ≈ 28.5 novels worth of text
```

## How It Works

```
~/.claude/projects/**/*.jsonl  ──→  LimitClock  ──→  Telegram Bot
       (session data)               (parser +         (notifications)
                                     watcher)
```

1. **Watches** `~/.claude/projects/` for JSONL session files
2. **Parses** token usage entries (input, output, cache) with timestamps
3. **Tracks** the rolling 5-hour window
4. **Schedules** a notification for when the oldest tokens expire
5. **Sends** a Telegram message the instant your capacity frees up

The bot also responds to commands so you can check your status on-demand from anywhere.

## Run as Service

### Option A: systemd (Linux)

```bash
# Copy service file
cp limitclock.service ~/.config/systemd/user/

# Enable & start
systemctl --user daemon-reload
systemctl --user enable limitclock
systemctl --user start limitclock

# Check status
systemctl --user status limitclock

# View logs
journalctl --user -u limitclock -f
```

### Option B: pm2

```bash
npm install -g pm2
pm2 start index.js --name limitclock
pm2 save
pm2 startup  # auto-start on boot
```

### Option C: Just run it

```bash
# In a tmux/screen session
npm start
```

## Configuration

All config lives in `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your personal chat ID |

## Requirements

- **Node.js** ≥ 18
- **Claude Code** installed (reads from `~/.claude/`)
- **Telegram** account

## Contributing

PRs welcome! This is a simple tool — if you have ideas for more stats, better notifications, or platform support, open an issue.

## License

MIT — do whatever you want with it.

---

<p align="center">
  Built because waiting for rate limits without knowing when they reset is painful. 🕐
</p>
