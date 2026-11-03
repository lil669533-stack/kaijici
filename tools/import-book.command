#!/bin/bash
# 从《王陆807雅思词汇精讲（听力篇）》PDF 生成本地词库。
# 只读取你自己的 PDF、只写本机，不联网。用法：
#   ./import-book.command <PDF路径> [输出JSON]
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$#" -lt 1 ] || [ -z "$1" ]; then
  echo "用法：bash tools/import-book.command <PDF路径> [输出JSON]"
  echo "请提供你自己准备的词汇书 PDF 路径。"
  exit 1
fi
PDF="$1"
OUT="${2:-$HOME/Applications/开机词/data/deck-book.json}"

if [ ! -f "$PDF" ]; then
  echo "找不到 PDF：$PDF"
  echo "用法：./import-book.command <PDF路径>"
  exit 1
fi
mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp -t kaijici-book)"

osascript -l JavaScript -e '
function run(argv) {
  ObjC.import("Quartz");
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) throw new Error("无法打开 PDF");
  var out = [];
  for (var i = 0; i < doc.pageCount; i++) {
    var s = doc.pageAtIndex(i).string;
    out.push("=== PAGE " + i + " ===\n" + (s.isNil() ? "" : ObjC.unwrap(s)));
  }
  return out.join("\n");
}' "$PDF" > "$TMP" || { echo "读取 PDF 失败"; rm -f "$TMP"; exit 1; }

/usr/bin/ruby "$DIR/import_book.rb" "$TMP" "$OUT" || { rm -f "$TMP"; exit 1; }
rm -f "$TMP"

echo "完成。刷新窗口（⌘R）即可看到新的场景词库。"
