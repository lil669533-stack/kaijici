#!/bin/bash
# 双击我：启动「开机词」并弹出学习窗口
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/Applications/开机词"

port_of() { cat "$TARGET/.port" 2>/dev/null || echo 8765; }
health() { curl -fsS --max-time 1 "http://127.0.0.1:$(port_of)/api/health" >/dev/null 2>&1; }

open_app() {
  local url="http://127.0.0.1:$(port_of)/"
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --app="$url" --window-size=1180,880 >/dev/null 2>&1
  else
    open "$url"
  fi
}

if health; then
  open_app
  exit 0
fi

# 把源码同步到安装目录（进度文件不会被覆盖）
mkdir -p "$TARGET/data" "$TARGET/log"
if [ "$DIR" != "$TARGET" ]; then
  rsync -a --delete "$DIR/app/" "$TARGET/app/" 2>/dev/null || cp -R "$DIR/app/." "$TARGET/app/"
  cp "$DIR/data/deck.json" "$TARGET/data/deck.json" 2>/dev/null
  cp "$DIR/README.md" "$TARGET/README.md" 2>/dev/null
fi

OPEN_ON_START=0 nohup /usr/bin/ruby "$TARGET/app/server.rb" >>"$TARGET/log/server.log" 2>&1 &

for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 0.3
  health && break
done

if health; then
  open_app
else
  echo "启动失败，看看 $TARGET/log/server.log 里的报错。"
  echo "按回车关闭…"
  read -r _
fi
