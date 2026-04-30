#!/bin/bash
# LimitClock — Quick install script
# Usage: curl -fsSL https://raw.githubusercontent.com/myrosama/LimitClock/main/install.sh | bash

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ╦  ╦╔╦╗╦╔╦╗╔═╗╦  ╔═╗╔═╗╦╔═"
echo "  ║  ║║║║║ ║ ║  ║  ║ ║║  ╠╩╗"
echo "  ╩═╝╩╩ ╩╩ ╩ ╚═╝╩═╝╚═╝╚═╝╩ ╩"
echo -e "${NC}"
echo "  Claude Code limit reset notifier"
echo ""

INSTALL_DIR="$HOME/.limitclock"

# Check deps
if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}Node.js not found. Install it first: https://nodejs.org${NC}"
  exit 1
fi

# Clone or update
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR" && git pull --ff-only
else
  echo "Installing to $INSTALL_DIR..."
  git clone https://github.com/myrosama/LimitClock.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

npm install --production

# Setup .env if not exists
if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo ""
  echo -e "${YELLOW}━━━ Setup Required ━━━${NC}"
  echo ""
  echo "1. Create a Telegram bot via @BotFather"
  echo "2. Get your chat ID via @userinfobot"
  echo ""
  read -p "Telegram Bot Token: " BOT_TOKEN
  read -p "Telegram Chat ID: " CHAT_ID
  echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" > "$INSTALL_DIR/.env"
  echo "TELEGRAM_CHAT_ID=$CHAT_ID" >> "$INSTALL_DIR/.env"
  echo -e "${GREEN}✓ Config saved${NC}"
fi

echo ""
echo -e "${GREEN}✅ Installed!${NC}"
echo ""
echo "Start manually:  cd $INSTALL_DIR && npm start"
echo "Run as service:  limitclock-service install"
echo ""

# Create launcher script
LAUNCHER="/usr/local/bin/limitclock"
if [ -w /usr/local/bin ] || [ "$(id -u)" = "0" ]; then
  cat > "$LAUNCHER" << 'SCRIPT'
#!/bin/bash
cd "$HOME/.limitclock" && node index.js
SCRIPT
  chmod +x "$LAUNCHER"
  echo -e "${GREEN}✓ Run anywhere with: limitclock${NC}"
fi

# Offer systemd setup
echo ""
read -p "Install as systemd service (auto-start on boot)? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  SERVICE_FILE="$HOME/.config/systemd/user/limitclock.service"
  mkdir -p "$(dirname "$SERVICE_FILE")"
  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=LimitClock — Claude Code rate limit notifier
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable limitclock
  systemctl --user start limitclock
  echo -e "${GREEN}✓ Service installed and started!${NC}"
  echo "  Status:  systemctl --user status limitclock"
  echo "  Logs:    journalctl --user -u limitclock -f"
fi
