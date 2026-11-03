#!/bin/bash
# 双击我：安装到 ~/Applications/开机词，并设置「每次登录自动打开」
#
# 为什么装在 ~/Applications：macOS 的隐私保护（TCC）不允许开机自启的后台进程
# 读取 ~/Documents 里的文件，程序放在这里才能被 launchd 正常启动。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/Applications/开机词"
LABEL="com.kaijici.daily"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"

echo "→ 安装到 $TARGET"
mkdir -p "$TARGET/data" "$TARGET/log" "$AGENT_DIR"

# 同步程序文件；data/progress.json 是学习进度，永远不覆盖
if [ "$DIR" != "$TARGET" ]; then
  rsync -a --delete "$DIR/app/" "$TARGET/app/" 2>/dev/null || cp -R "$DIR/app/." "$TARGET/app/"
  cp "$DIR/data/deck.json" "$TARGET/data/deck.json" 2>/dev/null
  cp "$DIR/README.md" "$TARGET/README.md" 2>/dev/null
fi

# 停掉旧的实例，避免端口被占导致新服务直接退出
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# 停掉所有旧实例（argv 可能是相对路径，所以按文件名匹配 + 按端口兜底）
pkill -f "app/server.rb" 2>/dev/null || true
for p in 8765 8766 8767 8768; do
  PIDS="$(lsof -ti tcp:"$p" 2>/dev/null || true)"
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null
done
sleep 0.8

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ruby</string>
    <string>$TARGET/app/server.rb</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$TARGET</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>$TARGET/log/server.log</string>
  <key>StandardErrorPath</key>
  <string>$TARGET/log/server.log</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
PLIST_EOF

if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST" 2>/dev/null || true
fi

# 等它起来，确认真的能访问
PORT=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.4
  PORT="$(cat "$TARGET/.port" 2>/dev/null || echo 8765)"
  if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "✅ 开机自启已装好，服务正在 http://127.0.0.1:$PORT/ 运行"
    echo "   以后每次登录 macOS 都会自动弹出学习窗口。"
    echo "   学习进度：$TARGET/data/progress.json"
    echo "   取消自启：双击 uninstall-autostart.command"
    exit 0
  fi
done

echo "⚠️  自启项已写入，但服务没起来。日志："
tail -8 "$TARGET/log/server.log" 2>/dev/null
echo
echo "按回车关闭…"
read -r _
