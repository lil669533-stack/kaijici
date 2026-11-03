#!/bin/bash
# 双击我：停止「开机词」（后台服务 + 开机自启）
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/Applications/开机词"
LABEL="com.kaijici.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null
fi

pkill -f "$TARGET/app/server.rb" 2>/dev/null || true
pkill -f "$DIR/app/server.rb" 2>/dev/null || true

echo "「开机词」已停止（词库和进度都还在）。"
echo "想重新开始：双击 start.command 或 install-autostart.command。"
