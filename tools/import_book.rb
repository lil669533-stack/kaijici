#!/usr/bin/env ruby
# frozen_string_literal: true
# 从《王陆807雅思词汇精讲（听力篇）》PDF 的文字层抽取词条，生成 app 用的词库。
#
# 用法：ruby import_book.rb <文本文件> <输出 json>
# 文本文件由 tools/import-book.command 调用 PDFKit 导出（每页以 === PAGE n === 开头）。
#
# 说明：只抽取「单词 + 中文释义/音标」，不保留书里的讲解文字；
# 结果只写到本机，用于个人复习。

require 'json'

text_file, out_file = ARGV
text_file = text_file.to_s.dup.force_encoding('UTF-8')
out_file  = out_file.to_s.dup.force_encoding('UTF-8')
abort '用法: ruby import_book.rb <文本> <输出json>' unless text_file && out_file
abort "找不到 #{text_file}" unless File.exist?(text_file)

raw = File.read(text_file, mode: 'r:UTF-8')
parts = raw.split(/^=== PAGE (\d+) ===\n/)
pages = {}
(1...parts.length).step(2) { |i| pages[parts[i].to_i] = parts[i + 1].to_s }

# 目录里的印刷页码（PDF 页 = 印刷页 + 12）
SCENES = [
  ['学科名称', 2], ['课程', 8], ['论文词汇', 21], ['图书馆词汇', 30],
  ['学生种类和证书种类', 33], ['出版物', 37], ['普通用词', 40],
  ['基础词汇（一）', 71], ['基础词汇（二）', 74], ['金融', 101],
  ['旅游', 109], ['人物', 115], ['交通', 117], ['住宿类型', 125],
  ['家具及设施', 130], ['饮食', 138], ['休闲生活', 145], ['动植物', 150],
  ['植物', 156], ['公司企业', 158], ['犯罪', 164], ['医疗场景', 165],
  ['环境', 173], ['运动', 176], ['电影', 181], ['建筑和建设', 198],
  ['__END__', 204]
].freeze
OFFSET = 12

CJK = /[\u4e00-\u9fa5]/
POS = /(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|int|art|aux|pl|a)\./
HEAD_RE = /\A([A-Za-z][A-Za-z'’\-.]*(?:\s+[A-Za-z'’\-.]*){0,3})\s*(?:[\[\(]([^\]\)]{1,50})[\]\)])?\s*(.*)\z/

SKIP_HEADS = %w[section ielts part test unit recycling 王陆807].freeze

# OCR 里零星出现的错拼（人工核对过的常见几例）
PHRASE_FIXES = {
  'cuitency form' => 'currency form',
  'refurbishment lri' => 'refurbishment'
}.freeze

FIXES = {
  'chemistiy' => 'chemistry', 'theoiy' => 'theory', 'stiucture' => 'structure',
  'teititory' => 'territory', 'govemment' => 'government', 'envhonment' => 'environment',
  'accomodation' => 'accommodation'
}.freeze

def clean_cn(s)
  s = s.to_s.strip
  s = s.sub(/\A[\s:：\-—–,，;；|]+/, '')
  # 去掉 OCR 成「几」「a#」的词性残留
  s = s.sub(/\A(?:几|a#)\s*/, '') if s.length > 2 && s[1] != '何'
  s = s.sub(/\A(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|int|art|aux|pl|a)\.?\s*/, '')
  s = s.sub(/\A[\s:：\-—–,，;；|]+/, '')
  s.gsub(/\s+/, ' ').strip
end


# 有的词条后面粘着 OCR 出来的音标碎片（如 "physical f'fizikl"），去掉它们
def clean_head(h)
  parts = h.to_s.strip.split(/\s+/)
  stop_tail = %w[and of the to in for with]
  while parts.length > 1
    last = parts[-1]
    ipa_like = last.include?("'") && last !~ /'s\z/i && last !~ /s'\z/ && last !~ /\A[OD]'/
    ipa_like ||= last =~ /[ˈˌəɪʊɔɑɜʃʒθðŋæʌɒ]/
    ipa_like ||= last =~ /[a-z][A-Z]/ && last !~ /\A[A-Z]+\z/
    ipa_like ||= last =~ /\A[A-Z][a-z]{1,2}\z/      # Led / La / Lp 这类音标碎片
    ipa_like ||= last =~ /\A[A-Z]\.\z/              # 词性残留 V.
    ipa_like ||= stop_tail.include?(last.downcase)     # 结尾的 and / of
    break unless ipa_like
    parts.pop
  end
  parts.join(' ')
end

def good_head?(h)
  h = h.strip
  return false if h.length < 2 || h.length > 30
  return false if h =~ /\d/
  return false if h.split(/\s+/).length > 4
  return false if SKIP_HEADS.include?(h.downcase)
  true
end

pos_token = /\A\s*(n|v|vt|vi|adj|adv|prep|conj|pron|num|int|art|aux)\./
entries = []
seen = {}
SCENES.each_cons(2) do |(name, start), (_, stop)|
  (start + OFFSET...stop + OFFSET).each do |pno|
    lines = pages[pno].to_s.split("\n").map(&:strip)
    lines.reject! do |ln|
      ln.empty? || ln =~ /\A\d{1,3}\z/ ||
        ln.include?('王陆807') || ln.include?('场景词汇') || ln.include?('分段测试词汇') ||
        ln =~ /\A[=\-—\s★☆]+\z/
    end

    i = 0
    while i < lines.length
      ln = lines[i]
      head = nil
      cn = ''
      pos = ''

      if (m = HEAD_RE.match(ln)) && ln =~ /[A-Za-z]/
        head = m[1]
        rest = m[3].to_s
        if (mp = pos_token.match(rest))
          pos = mp[1] + '.'
        elsif rest =~ /\A\s*几\s*#{CJK}/
          pos = 'n.'
        end
        idx = rest.index(CJK)
        cn = clean_cn(rest[idx..]) if idx
        # 词性/释义换行：下一行是 n.xxx 之类
        if cn.empty? && i + 1 < lines.length && lines[i + 1] =~ /\A(?:几|a#|#{POS})\s*#{CJK}/
          nxt = lines[i + 1]
          if (mp = pos_token.match(nxt))
            pos = mp[1] + '.'
          elsif nxt =~ /\A\s*几/
            pos = 'n.'
          end
          cn = clean_cn(nxt)
          i += 1
          # 再下一行可能才是音标
        end
        # 纯英文行 + 下一行中文释义
        if cn.empty? && i + 1 < lines.length && lines[i + 1] =~ /\A#{CJK}/ && rest.empty? && m[2].nil?
          cn = clean_cn(lines[i + 1])
          i += 1
        end
      end

      if head && good_head?(head)
        h = clean_head(head)
        h = FIXES.fetch(h.downcase, h) if h.split(/\s+/).length == 1
        h = PHRASE_FIXES.fetch(h.downcase, h) if h.include?(' ')
        cn = clean_cn(cn)
        if pos.empty? && h !~ /\s/
          pos =
            case h.downcase
            when /(tion|sion|ment|ness|ity|ance|ence|ship|ism|ist|ship)\z/ then 'n.'
            when /(ous|ive|able|ible|ful|less)\z/ then 'adj.'
            when /(ize|ise|fy)\z/ then 'v.'
            when /ly\z/ then 'adv.'
            else ''
            end
        end
        if !cn.empty? && cn =~ CJK && cn.length <= 60
          k = h.downcase
          unless seen[k]
            seen[k] = true
            entries << { 'w' => h, 'cn' => cn, 'pos' => pos, 'unit' => name }
          end
        end
      end
      i += 1
    end
  end
end

# 每 20 个一组
groups = []
units = []
SCENES.each do |(name, _)|
  list = entries.select { |e| e['unit'] == name }
  next if list.empty?
  units << { 'name' => name, 'total' => list.length }
  list.each_slice(20).with_index(1) do |slice, idx|
    total = (list.length / 20.0).ceil
    groups << {
      'id' => "g#{groups.length + 1}",
      'title' => total > 1 ? "#{name} · #{idx}" : name,
      'unit' => name,
      'hint' => "#{name}场景，第 #{idx} / #{total} 组，本组 #{slice.length} 个词",
      'words' => slice.map { |e| { 'w' => e['w'], 'cn' => e['cn'], 'pos' => e['pos'] } }
    }
  end
end

deck = {
  'meta' => {
    'name' => '王陆807 · 雅思听力场景词',
    'desc' => '按书里的场景顺序分组，每组 20 词',
    'perGroup' => 20,
    'builtin' => true,
    'units' => units
  },
  'groups' => groups
}

File.write(out_file, JSON.pretty_generate(deck).force_encoding('UTF-8'))
puts "抽取 #{entries.length} 个词，#{units.length} 个场景，#{groups.length} 组 → #{out_file}"
