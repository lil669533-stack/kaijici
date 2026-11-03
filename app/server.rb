#!/usr/bin/env ruby
# frozen_string_literal: true
# 开机词 · 本地服务（Ruby 自带 WEBrick，无需安装任何依赖）

require 'webrick'
require 'json'
require 'fileutils'
require 'socket'
require 'net/http'
require 'cgi'
require 'digest'

# launchd 启动时 LANG 为空，Ruby 会退回 US-ASCII；
# 安装目录含中文（开机词），不显式指定就会在 WEBrick 静态文件里抛 invalid byte sequence
Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = nil

ROOT     = File.expand_path('..', __dir__)
WEB_DIR  = File.join(ROOT, 'app', 'web')
DATA_DIR = File.join(ROOT, 'data')
LOG_DIR  = File.join(ROOT, 'log')
PROGRESS = File.join(DATA_DIR, 'progress.json')
DECK     = File.join(DATA_DIR, 'deck.json')
PORT_FILE = File.join(ROOT, '.port')
BASE_PORT = (ENV['PORT'] || 8765).to_i
MUTEX = Mutex.new

FileUtils.mkdir_p(DATA_DIR)
FileUtils.mkdir_p(LOG_DIR)

def already_running?(port)
  Net::HTTP.start('127.0.0.1', port, open_timeout: 0.4, read_timeout: 0.8) do |http|
    http.get('/api/health').code == '200'
  end
rescue StandardError
  false
end

def pick_port(start)
  (start...(start + 40)).each do |p|
    begin
      probe = TCPServer.new('127.0.0.1', p)
      probe.close
      return p
    rescue Errno::EADDRINUSE, Errno::EACCES
      next
    end
  end
  nil
end

def open_window(port)
  url = "http://127.0.0.1:#{port}/"
  marker = File.join(ROOT, '.last-open')
  begin
    return if File.exist?(marker) && (Time.now - File.mtime(marker)) < 90
    File.write(marker, Time.now.to_s)
  rescue StandardError
    # 忽略
  end

  chrome = '/Applications/Google Chrome.app'
  if File.directory?(chrome)
    # 用主 Chrome 实例打开 app 窗口，避免多出一个独立的 Chrome 图标
    system('open', '-na', 'Google Chrome', '--args', "--app=#{url}",
           '--window-size=1180,880', out: File::NULL, err: File::NULL)
  else
    system('open', url, out: File::NULL, err: File::NULL)
  end
end


# 静态文件服务：不用 WEBrick 自带的 FileHandler，
# 它会按请求行的 US-ASCII 编码处理路径，安装目录带中文时直接 500
class StaticServlet < WEBrick::HTTPServlet::AbstractServlet
  MIME = {
    '.html' => 'text/html; charset=utf-8',
    '.js'   => 'application/javascript; charset=utf-8',
    '.css'  => 'text/css; charset=utf-8',
    '.json' => 'application/json; charset=utf-8',
    '.svg'  => 'image/svg+xml',
    '.png'  => 'image/png',
    '.ico'  => 'image/x-icon'
  }.freeze

  def initialize(server, root)
    super(server)
    @root = File.expand_path(root)
  end


  def lookup_word(word)
    key = word.downcase
    @cache ||= {}
    @cache_mutex ||= Mutex.new
    cache_path = File.join(File.dirname(@path), 'lookup-cache.json')
    @cache_mutex.synchronize do
      unless @cache_loaded
        begin
          @cache = JSON.parse(File.read(cache_path, mode: 'r:UTF-8')) if File.exist?(cache_path)
        rescue StandardError
          @cache = {}
        end
        @cache_loaded = true
      end
      return @cache[key].merge('cached' => true) if @cache[key]
    end

    result = { 'ok' => false, 'w' => word, 'ipa' => '', 'pos' => '', 'cn' => '', 'rel' => [] }
    begin
      result.merge!(fetch_youdao(word))
      result['ok'] = true
    rescue StandardError => e
      result['error'] = e.message
    end

    @cache_mutex.synchronize do
      @cache[key] = result
      begin
        tmp = cache_path + '.tmp'
        File.write(tmp, JSON.generate(@cache))
        File.rename(tmp, cache_path)
      rescue StandardError
        # 缓存写失败不影响查询
      end
    end
    result
  end

  def http_get(url, limit = 3)
    raise 'too many redirects' if limit <= 0
    uri = URI.parse(url)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = (uri.scheme == 'https')
    http.open_timeout = 5
    http.read_timeout = 8
    req = Net::HTTP::Get.new(uri.request_uri)
    req['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    req['Accept-Language'] = 'zh-CN,zh;q=0.9'
    res = http.request(req)
    return http_get(URI.join(url, res['location']).to_s, limit - 1) if res.is_a?(Net::HTTPRedirection) && res['location']
    body = res.body.to_s
    body.force_encoding('UTF-8')
    body.valid_encoding? ? body : body.scrub
  end

  def fetch_youdao(word)
    return fetch_phrase(word) if word.include?(' ')
    q = CGI.escape(word)
    html = http_get("https://dict.youdao.com/w/eng/#{q}/")
    out = { 'ipa' => '', 'pos' => '', 'cn' => '', 'rel' => [] }

    if (m = html.match(/<span class="phonetic">\[([^\]]+)\]<\/span>/))
      out['ipa'] = m[1].strip
    end

    if (m = html.match(/<div class="trans-container">\s*<ul>(.*?)<\/ul>/m))
      senses = m[1].scan(/<li>(.*?)<\/li>/m).flatten.map { |x| CGI.unescapeHTML(x.gsub(/<[^>]+>/, '')).strip }.reject(&:empty?)
      joined = senses.join(' ')
      out['pos'] = joined[/\A\s*(n|v|vt|vi|adj|adv|prep|conj|pron|num|int|art)\./] ? "#{$1}." : ''
      out['cn'] = senses.first(3).map { |x| x.sub(/\A\s*(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|int|art)\.\s*/, '').strip }.reject(&:empty?).join('；')
    end

    out['rel'] = parse_rel_words(html)
    out
  end

  def fetch_phrase(word)
    out = { 'ipa' => '', 'pos' => '', 'cn' => '', 'rel' => [] }
    q = CGI.escape(word)
    # 有道对短语的释义在 jsonapi 的 aiDefinition 里
    begin
      data = JSON.parse(http_get("https://dict.youdao.com/jsonapi?q=#{q}"))
      content = ((((data['aiDefinition'] || {})['words'] || []).first || {})['content']).to_s
      content = content.gsub(/\s+/, ' ').strip
      out['cn'] = content[0, 120] unless content.empty?
    rescue StandardError
      out['cn'] = ''
    end
    # 兜底：机器翻译
    if out['cn'].empty?
      begin
        tr = JSON.parse(http_get("https://api.mymemory.translated.net/get?q=#{q.gsub('+', '%20')}&langpair=en|zh-CN"))
        out['cn'] = (((tr['responseData'] || {})['translatedText']) || '').to_s.strip
      rescue StandardError
        out['cn'] = ''
      end
    end
    out
  end

  def parse_rel_words(html)
    i = html.index('id="relWordTab"')
    return [] unless i
    seg = html[i, 8000].split('双语例句').first.to_s
    text = seg.gsub(/<[^>]+>/, ' ').gsub(/&nbsp;/, ' ').gsub(/\s+/, ' ')
    text = text.sub(/\A.*?词根：\s*\S+\s*/, '')
    out = []
    pos = ''
    cur = nil
    text.split(' ').each do |t|
      if t =~ /\A(?:n|adj|adv|v|vt|vi|prep|pron|num|int|art)\.\z/
        pos = t
      elsif t =~ /\A[A-Za-z][A-Za-z'\-]*\z/ && t.length > 1
        cur = { 'w' => t, 'pos' => pos, 'cn' => '' }
        out << cur
      elsif cur && t =~ /[\u4e00-\u9fa5]/
        cur['cn'] = (cur['cn'] + ' ' + t).strip
      end
    end
    out.select { |x| !x['cn'].empty? }.first(10)
  end

  def do_GET(req, res)
    raw = req.path_info.to_s
    raw = req.path.to_s if raw.empty?
    rel = WEBrick::HTTPUtils.unescape(raw.sub(%r{\A/}, ''))
    rel = 'index.html' if rel.empty? || rel.end_with?('/')
    full = File.expand_path(rel, @root)
    unless full == @root || full.start_with?(@root + File::SEPARATOR)
      raise WEBrick::HTTPStatus::NotFound
    end
    full = File.join(full, 'index.html') if File.directory?(full)
    raise WEBrick::HTTPStatus::NotFound unless File.file?(full)

    res['Content-Type'] = MIME[File.extname(full).downcase] || 'application/octet-stream'
    res['Cache-Control'] = 'no-cache'
    res.body = File.binread(full)
  end
  alias do_HEAD do_GET
end

# 进度读写接口

# 全局共享的朗读状态（WEBrick 每个请求都会新建 servlet 实例）
SAY_STATE = { pid: nil, mutex: Mutex.new }
WIN_STATE = { id: nil, ts: Time.at(0), mutex: Mutex.new }

class ApiServlet < WEBrick::HTTPServlet::AbstractServlet
  def initialize(server, mutex, progress_path, port)
    super(server)
    @mutex = mutex
    @path = progress_path
    @port = port
  end


  def lookup_word(word)
    key = word.downcase
    @cache ||= {}
    @cache_mutex ||= Mutex.new
    cache_path = File.join(File.dirname(@path), 'lookup-cache.json')
    @cache_mutex.synchronize do
      unless @cache_loaded
        begin
          @cache = JSON.parse(File.read(cache_path, mode: 'r:UTF-8')) if File.exist?(cache_path)
        rescue StandardError
          @cache = {}
        end
        @cache_loaded = true
      end
      return @cache[key].merge('cached' => true) if @cache[key]
    end

    result = { 'ok' => false, 'w' => word, 'ipa' => '', 'pos' => '', 'cn' => '', 'rel' => [] }
    begin
      result.merge!(fetch_youdao(word))
      result['ok'] = true
    rescue StandardError => e
      result['error'] = e.message
    end

    return result unless result['ok']

    @cache_mutex.synchronize do
      @cache[key] = result
      begin
        tmp = cache_path + '.tmp'
        File.write(tmp, JSON.generate(@cache))
        File.rename(tmp, cache_path)
      rescue StandardError
        # 缓存写失败不影响查询
      end
    end
    result
  end

  def http_get(url, limit = 3, retries = 1, binary = false)
    raise 'too many redirects' if limit <= 0
    begin
      uri = URI.parse(url)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = (uri.scheme == 'https')
      http.open_timeout = 8
      http.read_timeout = 12
      req = Net::HTTP::Get.new(uri.request_uri)
      req['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      req['Accept-Language'] = 'zh-CN,zh;q=0.9'
      res = http.request(req)
      if res.is_a?(Net::HTTPRedirection) && res['location']
        return http_get(URI.join(url, res['location']).to_s, limit - 1)
      end
      body = res.body.to_s
      return body if binary
      body.force_encoding('UTF-8')
      body.valid_encoding? ? body : body.scrub
    rescue Net::OpenTimeout, Net::ReadTimeout, Errno::ECONNRESET, OpenSSL::SSL::SSLError
      raise if retries <= 0
      sleep 0.5
      retries -= 1
      retry
    end
  end

  def fetch_youdao(word)
    q = CGI.escape(word).gsub('+', '%20')
    html = http_get("https://dict.youdao.com/w/eng/#{q}/")
    out = { 'ipa' => '', 'pos' => '', 'cn' => '', 'rel' => [] }

    if (m = html.match(/<span class="phonetic">\[([^\]]+)\]<\/span>/))
      out['ipa'] = m[1].strip.gsub("'", 'ˈ').gsub(',', 'ˌ')
    end

    if (m = html.match(/<div id="bilingual"[^>]*>\s*<ul class="ol">\s*<li>(.*?)<\/li>/m))
      ps = m[1].scan(/<p[^>]*>(.*?)<\/p>/m).flatten
      clean = lambda { |x| CGI.unescapeHTML(x.gsub(/<[^>]+>/, '')).gsub(/\s+/, ' ').strip }
      if ps[0] && ps[1]
        out['ex'] = clean.call(ps[0])
        out['exCn'] = clean.call(ps[1])
      end
    end

    if (m = html.match(/<div class="trans-container">\s*<ul>(.*?)<\/ul>/m))
      senses = m[1].scan(/<li>(.*?)<\/li>/m).flatten.map { |x| CGI.unescapeHTML(x.gsub(/<[^>]+>/, '')).strip }.reject(&:empty?)
      joined = senses.join(' ')
      out['pos'] = joined[/\A\s*(n|v|vt|vi|adj|adv|prep|conj|pron|num|int|art)\./] ? "#{$1}." : ''
      out['cn'] = senses.first(3).map { |x| x.sub(/\A\s*(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|int|art)\.\s*/, '').strip }.reject(&:empty?).join('；')[0, 100].to_s
    end

    out['rel'] = parse_rel_words(html)

    # 单词查不到释义时，短语走翻译接口
    if out['cn'].empty?
      out['cn'] = phrase_translation(word)
    end
    out
  end

  def phrase_translation(word)
    q = CGI.escape(word)
    begin
      data = JSON.parse(http_get("https://dict.youdao.com/jsonapi?q=#{q}"))
      content = ((((data['aiDefinition'] || {})['words'] || []).first || {})['content']).to_s
      content = CGI.unescapeHTML(content.gsub(/<[^>]+>/, ' ')).gsub(/\s+/, ' ').strip
      return content[0, 100] unless content.empty?
    rescue StandardError
      # 继续走下面的兜底
    end
    begin
      tr = JSON.parse(http_get("https://api.mymemory.translated.net/get?q=#{q.gsub('+', '%20')}&langpair=en|zh-CN"))
      return (((tr['responseData'] || {})['translatedText']) || '').to_s.strip
    rescue StandardError
      return ''
    end
  end

  def fetch_phrase(word)
    out = { 'ipa' => '', 'pos' => '', 'cn' => '', 'rel' => [] }
    q = CGI.escape(word)
    begin
      data = JSON.parse(http_get("https://dict.youdao.com/jsonapi?q=#{q}"))
      content = ((((data['aiDefinition'] || {})['words'] || []).first || {})['content']).to_s
      content = content.gsub(/\s+/, ' ').strip
      out['cn'] = content[0, 120] unless content.empty?
    rescue StandardError
      out['cn'] = ''
    end
    if out['cn'].empty?
      begin
        tr = JSON.parse(http_get("https://api.mymemory.translated.net/get?q=#{q.gsub('+', '%20')}&langpair=en|zh-CN"))
        out['cn'] = (((tr['responseData'] || {})['translatedText']) || '').to_s.strip
      rescue StandardError
        out['cn'] = ''
      end
    end
    out
  end

  def parse_rel_words(html)
    i = html.index('id="relWordTab"')
    return [] unless i
    seg = html[i, 8000].split('双语例句').first.to_s
    text = seg.gsub(/<[^>]+>/, ' ').gsub(/&nbsp;/, ' ').gsub(/\s+/, ' ')
    text = text.sub(/\A.*?词根：\s*\S+\s*/, '')
    out = []
    pos = ''
    cur = nil
    text.split(' ').each do |t|
      if t =~ /\A(?:n|adj|adv|v|vt|vi|prep|pron|num|int|art)\.\z/
        pos = t
      elsif t =~ /\A[A-Za-z][A-Za-z'\-]*\z/ && t.length > 1
        cur = { 'w' => t, 'pos' => pos, 'cn' => '' }
        out << cur
      elsif cur && t =~ /[\u4e00-\u9fa5]/
        cur['cn'] = (cur['cn'] + ' ' + t).strip
      end
    end
    out.select { |x| !x['cn'].empty? }.first(10)
  end

  def do_GET(req, res)
    res['Content-Type'] = 'application/json; charset=utf-8'
    res['Cache-Control'] = 'no-store'
    case req.path
    when '/api/ping'
      id = (req.query['id'] || '').to_s[0, 40]
      WIN_STATE[:mutex].synchronize do
        WIN_STATE[:id] = id unless id.empty?
        WIN_STATE[:ts] = Time.now
      end
      res['Cache-Control'] = 'no-store'
      res.body = JSON.generate(ok: true, latest: WIN_STATE[:id])
    when '/api/window'
      alive = (Time.now - WIN_STATE[:ts]) < 12
      res['Cache-Control'] = 'no-store'
      res.body = JSON.generate(alive: alive)
    when '/api/audio'
      q = (req.query['q'] || '').to_s.strip
      if q.empty? || q !~ /\A[A-Za-z][A-Za-z' \-]{0,60}\z/
        res.status = 400
        res.body = ''
        return
      end
      begin
        audio_dir = File.join(File.dirname(@path), 'audio')
        FileUtils.mkdir_p(audio_dir)
        key = Digest::MD5.hexdigest(q.downcase + '-2')
        file = File.join(audio_dir, key + '.mp3')
        unless File.exist?(file) && File.size(file) > 1000
          body = http_get("https://dict.youdao.com/dictvoice?audio=#{CGI.escape(q)}&type=2", 3, 1, true)
          raise 'empty audio' if body.nil? || body.bytesize < 1000
          File.write(file, body)
        end
        res['Content-Type'] = 'audio/mpeg'
        res['Cache-Control'] = 'public, max-age=604800'
        res.body = File.binread(file)
      rescue StandardError => e
        res.status = 404
        res['Content-Type'] = 'application/json'
        res.body = JSON.generate(ok: false, error: e.message)
      end
    when '/api/speak'
      q = (req.query['q'] || '').to_s.strip
      unless q =~ /\A[A-Za-z][A-Za-z' \-]{0,60}\z/
        res.status = 400
        res.body = JSON.generate(ok: false)
        return
      end
      begin
        SAY_STATE[:mutex].synchronize do
          if SAY_STATE[:pid]
            begin
              Process.kill('TERM', SAY_STATE[:pid])
            rescue Errno::ESRCH, Errno::EPERM
              # 上一句已经结束
            end
          end
          SAY_STATE[:pid] = Process.spawn('say', '-v', 'Samantha', '-r', '175', q,
                                          out: File::NULL, err: File::NULL)
          Process.detach(SAY_STATE[:pid])
        end
        res.body = JSON.generate(ok: true, via: 'say')
      rescue StandardError => e
        res.status = 500
        res.body = JSON.generate(ok: false, error: e.message)
      end
    when '/api/lookup'
      q = (req.query['q'] || '').to_s.strip
      unless q =~ /\A[A-Za-z][A-Za-z'\- ]{0,40}\z/
        res.status = 400
        res.body = JSON.generate(ok: false, error: 'bad word')
        return
      end
      res.body = JSON.generate(lookup_word(q))
    when '/api/health'
      res.body = JSON.generate(ok: true, port: @port, time: Time.now.to_s)
    else
      body = '{}'
      @mutex.synchronize do
        body = File.read(@path, mode: 'r:UTF-8') if File.exist?(@path)
      end
      res.body = body
    end
  rescue StandardError => e
    res.status = 500
    res.body = JSON.generate(error: e.message)
  end

  def do_POST(req, res)
    res['Content-Type'] = 'application/json; charset=utf-8'
    res['Cache-Control'] = 'no-store'
    raw = req.body.to_s.dup.force_encoding('UTF-8')
    if raw.bytesize > 32 * 1024 * 1024
      res.status = 413
      res.body = JSON.generate(error: 'too large')
      return
    end

    begin
      parsed = JSON.parse(raw)
      raise 'not an object' unless parsed.is_a?(Hash)
      raise 'missing progress' unless parsed.key?('progress')
    rescue StandardError => e
      res.status = 400
      res.body = JSON.generate(error: e.message)
      return
    end

    @mutex.synchronize do
      tmp = "#{@path}.tmp"
      File.write(tmp, raw)
      File.rename(tmp, @path)
    end
    res.body = JSON.generate(ok: true)
  end
end

if already_running?(BASE_PORT)
  puts "开机词已在运行：http://127.0.0.1:#{BASE_PORT}/"
  exit 0
end

port = pick_port(BASE_PORT)
if port.nil?
  warn '找不到可用端口（8765-8804 都被占用）'
  exit 1
end
File.write(PORT_FILE, port.to_s)

server = WEBrick::HTTPServer.new(
  Port: port,
  BindAddress: '127.0.0.1',
  DoNotReverseLookup: true,
  AccessLog: [],
  Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN)
)

server.mount('/api', ApiServlet, MUTEX, PROGRESS, port)
server.mount('/data', StaticServlet, DATA_DIR)
server.mount('/', StaticServlet, WEB_DIR)

# 健康检查：确保浏览器打开时服务已就绪
Thread.new do
  sleep 0.7
  unless ENV['OPEN_ON_START'] == '0'
    begin
      open_window(port)
    rescue StandardError => e
      warn "打开窗口失败：#{e.message}"
    end
  end
end

%w[INT TERM].each do |sig|
  trap(sig) do
    Thread.new { server.shutdown }
  end
end

puts "开机词已启动：http://127.0.0.1:#{port}/"
server.start
puts '开机词已停止'
