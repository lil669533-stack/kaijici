# 开机词 · 每天 20 词

一个在 macOS 本机运行的背单词工具：每天学一组词，用间隔复习巩固记忆，也可以设置为登录电脑后自动打开。

## 功能

- 每组默认 20 个词，按分组学习、复习到期词。
- 卡片回忆、看词选义、听音拼写，以及认识后的拼写检查。
- 音标、词性和词根词缀提示；支持自动朗读和听音模式。
- 多本生词本，可手动添加单词、查询释义、单独复习。
- 支持导入自己的词表，学习进度保存在本机。

## 开始使用

需要 macOS，以及可用的 `/usr/bin/ruby` 和 WEBrick。程序使用系统 Ruby 启动；可先在终端检查：

```bash
/usr/bin/ruby -rwebrick -e 'puts WEBrick::VERSION'
```

下载并解压项目，先在终端进入项目文件夹并运行以下命令，允许脚本直接打开：

```bash
chmod +x *.command tools/*.command
```

然后双击 `start.command`。它会将程序安装到 `~/Applications/开机词`，启动本地服务并打开学习窗口。有 Google Chrome 时优先使用 Chrome 窗口，否则使用默认浏览器。

也可以在终端进入项目文件夹后运行：

```bash
bash start.command
```

默认地址为 <http://127.0.0.1:8765/>。端口被占用时服务会尝试后续端口，实际端口记录在 `~/Applications/开机词/.port`。

- **登录后自动打开**：双击 `install-autostart.command`。
- **取消自启并停止服务**：双击 `uninstall-autostart.command`。
- **停止服务**：双击 `stop.command`；之后可通过 `start.command` 再次启动。
- **更新程序**：在新版本项目文件夹中重新运行 `install-autostart.command`，同步程序并重启服务。已有学习进度会保留。

## 词库

仓库包含 `data/deck.json`，共 **120 个示例词**，可直接体验学习流程。也可以在应用内导入自己的词表，使用 `单词 中文释义` 格式，每行一个词；用 `# 组名` 指定分组。

`tools/import-book.command` 可读取自备的《王陆807雅思词汇精讲（听力篇）》PDF 的文字层，生成本地场景词库。必须显式提供文件路径：

```bash
bash tools/import-book.command "/路径/你的词汇书.pdf"
```

默认输出到 `~/Applications/开机词/data/deck-book.json`，完成后刷新学习窗口。此工具按特定书籍版式和页码解析，并非通用 PDF 导入器；不同版本及 OCR 质量可能影响结果。

PDF 和从书籍提取的完整词库需由使用者自行准备，本仓库仅附示例词库。

## 数据与联网

学习服务只监听本机地址 `127.0.0.1`。学习进度和生词本保存在本地；浏览器也会保留本地缓存。查询释义和在线发音需要联网，会向有道及翻译服务发送待查询的单词或短语。在线发音不可用时会尝试系统语音。

| 内容 | 默认位置 |
| --- | --- |
| 学习进度、生词本、自定义词表 | `~/Applications/开机词/data/progress.json` |
| 自备 PDF 生成的场景词库 | `~/Applications/开机词/data/deck-book.json` |
| 示例词库 | `~/Applications/开机词/data/deck.json` |
| 查询与发音缓存 | `~/Applications/开机词/data/lookup-cache.json`、`data/audio/` |
| 服务日志 | `~/Applications/开机词/log/server.log` |

备份时复制自己的数据文件即可。仓库的 `.gitignore` 已排除个人进度、生词本、书籍词库、查询和音频缓存、日志等运行数据。

## 自测与排查

服务启动后，访问 <http://127.0.0.1:8765/selftest.html> 运行现有的核心逻辑自测；如端口变化，替换为实际端口。

启动失败时，先检查系统 Ruby / WEBrick 是否可用，再查看 `~/Applications/开机词/log/server.log`。词表存在 OCR 错误时，可以修正自己的词库文件后刷新页面。
