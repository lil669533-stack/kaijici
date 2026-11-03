#!/bin/bash
# 双击我：取消「开机自动打开」
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/Applications/开机词"
LABEL="com.kaijici.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null
rm -f "$PLIST"
pkill -f "$TARGET/app/server.rb" 2>/dev/null || true

echo "已取消开机自启，服务也停了。"
echo "程序和学习进度还在 $TARGET，没有删除。"
echo "想恢复：双击 install-autostart.command。"
