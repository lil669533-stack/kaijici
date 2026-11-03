/* 开机词 · 核心逻辑（纯函数，便于测试）
 * 日期工具 / 间隔复习 / 每日计划 / 词表解析 / 关联分组 / 统计
 */
(function (global) {
  'use strict';

  var DAY = 86400000;

  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayKey() { return dateKey(new Date()); }
  function parseKey(s) { var p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { var d = parseKey(s); d.setDate(d.getDate() + n); return dateKey(d); }
  function daysBetween(a, b) { return Math.round((parseKey(b) - parseKey(a)) / DAY); }
  function weekdayCN(s) { return '日一二三四五六'[parseKey(s).getDay()]; }
  function cnDate(s) { var d = parseKey(s); return (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + weekdayCN(s); }

  /* ---------------- 词条记录与间隔复习 ---------------- */

  function blankRec() {
    return { ease: 2.5, interval: 0, due: null, reps: 0, lapses: 0, seen: 0, last: null, lastGrade: null };
  }
  function keyOf(word) { return String(word.w || word).trim().toLowerCase(); }
  function recOf(progress, word) {
    var r = progress[keyOf(word)];
    return r ? Object.assign(blankRec(), r) : blankRec();
  }
  function isSeen(rec) { return !!(rec && rec.seen > 0); }
  function isDue(rec, today) { return !!(rec && rec.seen > 0 && rec.due && rec.due <= (today || todayKey())); }

  /* 三档评分：again 不认识 / hard 模糊 / good 认识 */
  function review(rec, grade, today) {
    var r = Object.assign(blankRec(), rec || {});
    today = today || todayKey();
    r.seen += 1;
    r.last = today;
    r.lastGrade = grade;

    if (grade === 'again') {
      r.lapses += 1;
      r.ease = Math.max(1.3, +(r.ease - 0.2).toFixed(2));
      r.interval = 0;
      r.reps = 0;
      r.due = today;
    } else if (grade === 'hard') {
      r.ease = Math.max(1.3, +(r.ease - 0.08).toFixed(2));
      r.interval = Math.max(1, Math.round((r.interval || 0) * 0.6));
      r.reps += 1;
      r.due = addDays(today, r.interval);
    } else {
      r.ease = Math.min(2.8, +(r.ease + 0.06).toFixed(2));
      r.interval = r.reps === 0 ? 1 : Math.max(r.interval + 1, Math.round(r.interval * r.ease));
      r.reps += 1;
      r.due = addDays(today, r.interval);
    }
    return r;
  }

  function statusOf(rec) {
    if (!isSeen(rec)) return 'new';
    if ((rec.interval || 0) >= 21) return 'mastered';
    return 'learning';
  }
  function fmtDue(rec, today) {
    if (!isSeen(rec)) return '未学';
    var t = today || todayKey();
    var d = daysBetween(t, rec.due);
    if (d <= 0) return '今天复习';
    if (d === 1) return '明天复习';
    return d + ' 天后复习';
  }

  /* ---------------- 每日计划 ---------------- */

  function allWords(deck) {
    var out = [];
    (deck.groups || []).forEach(function (g, gi) {
      (g.words || []).forEach(function (w, wi) {
        out.push({ w: w, group: g, gi: gi, wi: wi });
      });
    });
    return out;
  }

  function firstUnfinishedGroup(deck, progress) {
    var groups = deck.groups || [];
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].words.length; j++) {
        if (!isSeen(progress[keyOf(groups[i].words[j])])) return { group: groups[i], index: i };
      }
    }
    return null;
  }

  function planFor(deck, progress, days, today, opts) {
    opts = opts || {};
    var perDay = opts.perDay || (deck.meta && deck.meta.perGroup) || 20;
    var limit = opts.reviewLimit || 40;
    var words = allWords(deck);
    var due = words.filter(function (x) { return isDue(progress[keyOf(x.w)], today); })
      .sort(function (a, b) {
        var ra = progress[keyOf(a.w)], rb = progress[keyOf(b.w)];
        return String(ra.due).localeCompare(String(rb.due));
      })
      .slice(0, limit)
      .map(function (x) { return x.w; });

    var day = (days && days[today]) || { newDone: 0, reviewDone: 0 };
    var slot = firstUnfinishedGroup(deck, progress);
    var allowed = Math.max(0, perDay - (day.newDone || 0));
    var fresh = slot ? slot.group.words.filter(function (w) { return !isSeen(progress[keyOf(w)]); }).slice(0, allowed) : [];

    return {
      review: due,
      fresh: fresh,
      group: slot ? slot.group : null,
      groupIndex: slot ? slot.index : -1,
      newDone: day.newDone || 0,
      reviewDone: day.reviewDone || 0,
      perDay: perDay
    };
  }

  /* ---------------- 统计 ---------------- */

  function streak(days, today) {
    var t = today || todayKey();
    var has = function (k) { var d = days[k]; return !!(d && ((d.newDone || 0) + (d.reviewDone || 0)) > 0); };
    var cursor = has(t) ? t : addDays(t, -1);
    var n = 0;
    while (has(cursor) && n < 3650) { n++; cursor = addDays(cursor, -1); }
    return n;
  }

  function recentDays(days, today, n) {
    n = n || 14;
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var k = addDays(today || todayKey(), -i);
      var d = days[k] || {};
      out.push({ key: k, label: parseKey(k).getDate(), count: (d.newDone || 0) + (d.reviewDone || 0), newDone: d.newDone || 0, reviewDone: d.reviewDone || 0 });
    }
    return out;
  }

  function mastery(deck, progress) {
    var m = { new: 0, learning: 0, mastered: 0, total: 0 };
    allWords(deck).forEach(function (x) {
      m[statusOf(progress[keyOf(x.w)])] += 1;
      m.total += 1;
    });
    return m;
  }

  /* ---------------- 关联分组用的主题词库 ---------------- */
  /* roots 用于英文词匹配，cn 用于中文释义匹配；root 越具体越优先 */
  var THEMES = [
    { id: 'work', name: '职场与求职', hint: '简历、面试、合同、晋升——一条职业时间线', roots: ['employ', 'recruit', 'career', 'interview', 'colleague', 'staff', 'hire', 'resign', 'salary', 'wage', 'contract', 'promotion', 'vacancy', 'intern', 'probation', 'overtime', 'colleagu'], cn: ['工作', '职业', '面试', '简历', '雇佣', '同事', '老板', '员工', '招聘', '薪水', '工资', '合同', '晋升', '加班', '实习', '试用', '辞职', '上班', '办公', '职位', '雇主', '雇员'] },
    { id: 'money', name: '金钱与交易', hint: '价格、支付、投资、预算——和钱有关的一整条链', roots: ['financ', 'econom', 'invest', 'profit', 'budget', 'price', 'cost', 'pay', 'bank', 'cash', 'account', 'tax', 'loan', 'debt', 'credit', 'fund', 'purchas', 'afford', 'wealth', 'income', 'expens'], cn: ['钱', '支付', '价格', '银行', '金融', '经济', '投资', '利润', '预算', '税', '费用', '花费', '账户', '贷款', '债务', '现金', '购买', '商品', '市场', '财富', '收入', '贫富', '成本'] },
    { id: 'law', name: '法律与规则', hint: '合法 / 违法，权利 / 义务，成对记更牢', roots: ['legal', 'court', 'judg', 'crime', 'punish', 'prison', 'arrest', 'trial', 'justic', 'legisl', 'regul', 'forbid', 'permit', 'licens', 'oblig'], cn: ['法律', '法院', '判决', '罪', '警察', '律师', '合法', '违法', '规定', '禁止', '允许', '权利', '义务', '责任', '拘留', '监'] },
    { id: 'study', name: '学习与研究', hint: '从课堂到论文，再到实验室', roots: ['study', 'learn', 'educ', 'academ', 'research', 'knowledg', 'scien', 'theor', 'exam', 'teach', 'student', 'school', 'univers', 'essay', 'thesis', 'experiment', 'laborator', 'scholar'], cn: ['学习', '教育', '研究', '知识', '科学', '理论', '学', '课', '考试', '论文', '实验', '教授', '学生', '学校', '复习', '作业', '图书馆'] },
    { id: 'env', name: '环境与自然', hint: '问题（污染）→ 后果（变暖）→ 解法（可持续）', roots: ['environ', 'ecolog', 'pollut', 'climat', 'forest', 'ocean', 'species', 'natur', 'carbon', 'recycl', 'emission', 'habitat', 'extinct', 'solar', 'drought', 'irrigat', 'conserv'], cn: ['环境', '污染', '自然', '气候', '森林', '海洋', '物种', '生态', '能源', '垃圾', '排放', '保护', '天气', '地球', '空气', '干旱', '濒危', '灌溉', '可再生'] },
    { id: 'body', name: '身体与健康', hint: '症状 → 看病 → 治疗 → 康复', roots: ['medic', 'health', 'disease', 'injur', 'cure', 'treat', 'surger', 'drug', 'hospital', 'doctor', 'patient', 'diet', 'exercis', 'muscl', 'blood', 'brain', 'heart', 'sleep', 'immune', 'virus'], cn: ['医', '病', '健康', '疼痛', '受伤', '治疗', '药', '医院', '医生', '病人', '饮食', '运动', '肌肉', '骨', '血', '脑', '心', '睡', '身体', '症状', '康复'] },
    { id: 'food', name: '饮食与味道', hint: '食材 → 烹饪 → 味道 → 餐桌', roots: ['cook', 'food', 'taste', 'flavor', 'restaur', 'meal', 'recip', 'ingredient', 'delici', 'hunger', 'thirst', 'veget', 'fruit', 'bread', 'sugar', 'salt', 'coffee', 'kitchen'], cn: ['食物', '吃', '喝', '味道', '餐', '菜', '烹饪', '食材', '新鲜', '美味', '饥饿', '渴', '咖啡', '茶', '蔬菜', '水果', '肉', '面包', '糖', '盐', '饮食', '厨房'] },
    { id: 'travel', name: '旅行与交通', hint: '出发 → 在路上 → 到达 → 住宿', roots: ['travel', 'journey', 'tour', 'trip', 'transport', 'flight', 'airport', 'station', 'hotel', 'ticket', 'luggage', 'passeng', 'traff', 'drive', 'sail', 'cruis', 'abroad', 'visit', 'destinat'], cn: ['旅行', '旅游', '交通', '航班', '机场', '车站', '酒店', '票', '行李', '乘客', '道路', '驾驶', '地图', '出国', '参观', '出发', '到达', '迷路', '住宿'] },
    { id: 'emotion', name: '情绪与性格', hint: '把情绪排成光谱，把性格两两配对', roots: ['emotion', 'anx', 'nerv', 'jealous', 'confid', 'optim', 'pessim', 'frustrat', 'excit', 'bored', 'calm', 'temper', 'gener', 'humble', 'stubborn', 'mood', 'grateful', 'guilty', 'sensitiv', 'aggress'], cn: ['情绪', '感情', '高兴', '悲伤', '生气', '害怕', '焦虑', '紧张', '嫉妒', '骄傲', '害羞', '自信', '乐观', '悲观', '沮丧', '兴奋', '无聊', '平静', '心情', '脾气', '慷慨', '谦逊', '固执', '感激', '内疚', '同理'] },
    { id: 'comm', name: '沟通与语言', hint: '说、听、读、写——四种动作各来几个', roots: ['communicat', 'languag', 'speak', 'translat', 'express', 'discuss', 'argu', 'debat', 'conversat', 'speech', 'voic', 'listen', 'writ', 'read', 'letter', 'email', 'messag', 'news'], cn: ['沟通', '语言', '说', '谈', '词', '翻译', '表达', '讨论', '争论', '辩论', '对话', '演讲', '声音', '听', '写', '读', '信', '邮件', '消息', '新闻', '报道'] },
    { id: 'think', name: '思维与判断', hint: '假设 → 证据 → 推理 → 结论', roots: ['logic', 'reason', 'analys', 'judg', 'decis', 'consider', 'doubt', 'believ', 'opinion', 'concept', 'assum', 'conclu', 'evid', 'prove', 'mistak', 'think', 'thought'], cn: ['思考', '逻辑', '推理', '分析', '判断', '决定', '考虑', '怀疑', '相信', '观点', '想法', '概念', '假设', '结论', '证明', '证据', '真', '假', '错误', '认为'] },
    { id: 'change', name: '变化与趋势', hint: '上升 / 下降，增长 / 减少，成对记', roots: ['chang', 'transform', 'develop', 'grow', 'increas', 'decreas', 'trend', 'evolv', 'progress', 'improv', 'declin', 'expand', 'reduc', 'shift'], cn: ['变化', '转变', '发展', '增长', '增加', '减少', '上升', '下降', '趋势', '进步', '改善', '扩大', '缩小', '改变', '提高', '降低'] },
    { id: 'society', name: '社会与人群', hint: '从个人到群体，再到制度', roots: ['societ', 'commun', 'public', 'citizen', 'popul', 'cultur', 'tradit', 'custom', 'generat', 'immigr', 'urb', 'rural', 'equal', 'freedom', 'poverty'], cn: ['社会', '社区', '公共', '公民', '人口', '文化', '传统', '习俗', '一代', '群体', '成员', '移民', '城市', '农村', '阶层', '平等', '自由', '贫困'] },
    { id: 'tech', name: '科技与网络', hint: '硬件 → 软件 → 数据 → 智能', roots: ['technolog', 'comput', 'digit', 'internet', 'network', 'softwar', 'hardwar', 'data', 'algorith', 'robot', 'machin', 'electr', 'device', 'screen', 'onlin', 'virtu', 'artifici', 'intellig'], cn: ['科技', '技术', '电脑', '数字', '网络', '数据', '软件', '硬件', '机器', '电子', '设备', '屏幕', '在线', '虚拟', '人工智能', '智能'] },
    { id: 'art', name: '艺术与审美', hint: '创作 → 作品 → 欣赏', roots: ['music', 'paint', 'design', 'photo', 'film', 'movie', 'theater', 'dance', 'literat', 'novel', 'poem', 'style', 'beauti', 'creat', 'imagin', 'artist'], cn: ['艺术', '音乐', '绘画', '设计', '摄影', '电影', '戏剧', '舞蹈', '文学', '小说', '诗', '风格', '美', '创造', '想象', '作品'] },
    { id: 'sport', name: '运动与竞技', hint: '训练 → 比赛 → 胜负', roots: ['sport', 'match', 'compet', 'coach', 'athlet', 'football', 'basket', 'swim', 'rac', 'score', 'champion', 'stadium', 'train'], cn: ['运动', '比赛', '球队', '竞争', '赢', '输', '教练', '训练', '运动员', '足球', '篮球', '游泳', '跑', '赛', '得分', '冠军'] },
    { id: 'war', name: '冲突与安全', hint: '威胁 → 冲突 → 防御 → 和平', roots: ['war', 'fight', 'attack', 'defen', 'army', 'soldier', 'weapon', 'peace', 'conflict', 'terror', 'threat', 'secur', 'violen', 'protest'], cn: ['战争', '战斗', '攻击', '防御', '军队', '士兵', '武器', '和平', '冲突', '恐怖', '威胁', '安全', '暴力', '抗议'] },
    { id: 'home', name: '家与居住', hint: '房子 → 房间 → 家具 → 邻里', roots: ['hous', 'room', 'furnitur', 'kitchen', 'garden', 'rent', 'neighb', 'build', 'archit', 'resid', 'apart', 'settl'], cn: ['家', '房子', '房间', '家具', '厨房', '花园', '租', '邻居', '建筑', '居住', '公寓', '定居'] },
    { id: 'cloth', name: '服饰与外观', hint: '穿什么 → 看起来怎样', roots: ['cloth', 'wear', 'dress', 'fashion', 'appear', 'hair', 'shoe', 'uniform', 'cosmet', 'jewel'], cn: ['衣服', '穿着', '时尚', '外貌', '头发', '鞋', '帽', '制服', '化妆', '首饰'] },
    { id: 'quantity', name: '数量与程度', hint: '数字、比例、大小、多少', roots: ['amount', 'number', 'quantit', 'measur', 'total', 'averag', 'percent', 'ratio', 'scale'], cn: ['数量', '数字', '测量', '总数', '平均', '百分', '比例', '规模', '大量', '少量', '足够', '额外', '倍', '半'] },
    { id: 'time', name: '时间与顺序', hint: '过去 → 现在 → 未来，先 / 后', roots: ['season', 'moment', 'period', 'ancien', 'modern', 'futur', 'early', 'often', 'alway', 'neve', 'while', 'dur', 'centur', 'decade'], cn: ['时间', '小时', '天', '周', '月', '年', '季节', '时刻', '时期', '古代', '现代', '未来', '过去', '早', '晚', '经常', '总是', '从不', '很快', '期间', '世纪'] },
    { id: 'place', name: '空间与方位', hint: '位置、距离、内外、上下', roots: ['posit', 'locat', 'area', 'region', 'space', 'distanc', 'abov', 'below', 'insid', 'outsid', 'between', 'front', 'behind'], cn: ['地方', '位置', '地区', '空间', '距离', '上面', '下面', '里面', '外面', '之间', '前面', '后面', '附近', '远处'] },
    { id: 'family', name: '家庭与关系', hint: '父母 → 子女 → 伴侣 → 朋友', roots: ['famil', 'parent', 'father', 'mother', 'child', 'daughter', 'brother', 'sister', 'marri', 'husband', 'wife', 'relat', 'friend', 'birth', 'raise'], cn: ['家庭', '父母', '父亲', '母亲', '孩子', '儿子', '女儿', '兄弟', '姐妹', '结婚', '丈夫', '妻子', '关系', '朋友', '爱', '出生', '抚养'] },
    { id: 'animal', name: '动物与植物', hint: '飞禽走兽、花草树木、农作物', roots: ['anim', 'bird', 'fish', 'insect', 'plant', 'flower', 'crop', 'farm'], cn: ['动物', '鸟', '鱼', '狗', '猫', '马', '昆虫', '植物', '树', '花', '庄稼', '农场'] },
    { id: 'weather', name: '天气与季节', hint: '晴雨冷暖，四季轮转', roots: ['weather', 'rain', 'snow', 'wind', 'storm', 'cloud', 'temperatur', 'humid', 'season'], cn: ['天气', '雨', '雪', '风', '暴', '云', '太阳', '温度', '热', '冷', '湿', '干', '季节'] },
    { id: 'gov', name: '政治与治理', hint: '选举 → 政策 → 国家', roots: ['govern', 'polit', 'president', 'elect', 'vot', 'policy', 'democrat', 'republ', 'minist', 'official', 'nation'], cn: ['政府', '政治', '总统', '选举', '投票', '政策', '民主', '官员', '国家', '民族', '统治'] },
    { id: 'media', name: '媒体与传播', hint: '采写 → 编辑 → 发布 → 传播', roots: ['media', 'journal', 'press', 'broadcast', 'advertis', 'publish', 'headlin'], cn: ['媒体', '新闻', '记者', '广播', '广告', '出版', '报道', '采访'] }
  ];

  function rootHit(word, root) {
    if (!root) return false;
    if (root.length >= 4) return word.indexOf(root) !== -1;
    return word.indexOf(root) === 0;
  }

  function guessTheme(entry) {
    var w = String(entry.w || '').toLowerCase();
    var cn = String(entry.cn || '');
    var best = null, bestScore = 0;
    for (var i = 0; i < THEMES.length; i++) {
      var t = THEMES[i], score = 0;
      for (var r = 0; r < t.roots.length; r++) {
        if (rootHit(w, t.roots[r])) score += 3 + Math.min(3, t.roots[r].length - 4);
      }
      for (var c = 0; c < t.cn.length; c++) {
        if (cn.indexOf(t.cn[c]) !== -1) score += 2;
      }
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return { theme: best || { id: 'other', name: '综合词汇', hint: '跨主题的高频词，混着记', roots: [], cn: [] }, score: bestScore };
  }

  function chunk(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  /* 把任意词条列表按关联性切成每组 n 个 */
  function groupInto20(entries, perGroup) {
    perGroup = perGroup || 20;
    var buckets = {}, order = [], tails = [];
    entries.forEach(function (e) {
      var g = guessTheme(e);
      if (!buckets[g.theme.id]) { buckets[g.theme.id] = { theme: g.theme, list: [] }; order.push(g.theme.id); }
      buckets[g.theme.id].list.push(e);
    });

    var groups = [];
    order.forEach(function (id) {
      var b = buckets[id];
      var parts = chunk(b.list, perGroup);
      parts.forEach(function (p, i) {
        if (p.length === perGroup) {
          groups.push({
            id: 't-' + id + '-' + i,
            title: b.theme.name + (parts.length > 1 ? ' · ' + (i + 1) : ''),
            hint: b.theme.hint,
            words: p.map(toWord)
          });
        } else {
          tails = tails.concat(p);
        }
      });
    });

    chunk(tails, perGroup).forEach(function (p, i) {
      groups.push({
        id: 't-mix-' + i,
        title: '查漏补缺 · ' + (i + 1),
        hint: '跨主题的剩余词，混着记一遍',
        words: p.map(toWord)
      });
    });

    return groups.map(function (g, i) {
      g.id = 'g' + (i + 1);
      return g;
    });
  }

  function toWord(e) {
    return {
      w: e.w,
      ipa: e.ipa || '',
      pos: e.pos || '',
      cn: e.cn || '',
      ex: e.ex || '',
      exCn: e.exCn || '',
      note: e.note || ''
    };
  }

  /* ---------------- 词表解析 ---------------- */

  function parseWordList(text, perGroup) {
    var lines = String(text || '').split(/\r?\n/);
    var out = [], seen = {}, topic = null, topics = {};
    var CJK = /[\u4e00-\u9fa5]/;

    lines.forEach(function (raw) {
      var line = raw.replace(/\u00a0/g, ' ').trim();
      if (!line) return;
      if (/^#/.test(line)) { topic = line.replace(/^#+\s*/, '').trim() || null; if (topic) topics[topic] = true; return; }
      line = line.replace(/^\d+\s*[.、)）]\s*/, '').replace(/^[-*•·]\s*/, '');

      // 抽取音标 /.../
      var ipa = '';
      var ipaMatch = line.match(/\/([^\/]{2,40})\//);
      if (ipaMatch) { ipa = ipaMatch[1].trim(); line = line.replace(ipaMatch[0], ' '); }

      // 以第一个中文字符为界：前面英文，后面释义
      var cut = line.search(CJK);
      var head, meaning;
      if (cut > 0) {
        head = line.slice(0, cut);
        meaning = line.slice(cut);
      } else if (line.indexOf('\t') !== -1) {
        var parts = line.split('\t');
        head = parts.shift(); meaning = parts.join(' ').trim();
      } else {
        var m = line.match(/^([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z'’\-]+){0,2})\s+(.*)$/);
        if (!m) return;
        head = m[1]; meaning = m[2];
      }

      var word = head.replace(/[^A-Za-z'’\- ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!word || !/^[A-Za-z][A-Za-z'’\- ]*$/.test(word)) return;
      if (word.length > 40) return;
      meaning = meaning.replace(/^[\s:：\-—–,，;；|]+/, '').replace(/\s+/g, ' ').trim();
      if (!meaning) meaning = '—';

      var k = word.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      var item = { w: word, cn: meaning };
      if (ipa) item.ipa = '/' + ipa + '/';
      if (topic) item.topic = topic;
      out.push(item);
    });

    // 如果用户用 # 标题显式分了组，优先按标题分组
    var hasTopics = out.some(function (x) { return x.topic; });
    var groups;
    if (hasTopics) {
      var order = [], map = {};
      out.forEach(function (x) {
        var t = x.topic || '其他';
        if (!map[t]) { map[t] = []; order.push(t); }
        map[t].push(x);
      });
      groups = [];
      order.forEach(function (t) {
        chunk(map[t], perGroup || 20).forEach(function (p, i) {
          groups.push({
            id: 'g' + (groups.length + 1),
            title: t + (map[t].length > (perGroup || 20) ? ' · ' + (i + 1) : ''),
            hint: '按你的标题自动分组',
            words: p.map(toWord)
          });
        });
      });
    } else {
      groups = groupInto20(out, perGroup || 20);
    }

    return { words: out, groups: groups, count: out.length };
  }

  /* ---------------- 其它 ---------------- */



  /* ---------------- 后缀 / 派生词 ---------------- */
  var SUFFIXES = [
    ['ically', '构成副词'], ['ological', '…学的'], ['ability', '构成名词：能力'],
    ['ibility', '构成名词：能力'], ['ation', '构成名词'], ['ition', '构成名词'],
    ['ology', '构成名词：…学'], ['ography', '构成名词：…学/记录'], ['graphy', '构成名词：…学/记录'],
    ['ical', '构成形容词'], ['ancy', '构成名词：性质/职业'], ['ency', '构成名词：性质/状态'],
    ['ance', '构成名词'], ['ence', '构成名词'],
    ['ment', '构成名词'], ['ness', '构成名词：性质'], ['ship', '构成名词：身份/状态'],
    ['hood', '构成名词：时期/状态'], ['ism', '构成名词：主义/学说'], ['ist', '构成名词：人'],
    ['ity', '构成名词：性质'], ['tion', '构成名词'], ['sion', '构成名词'],
    ['ive', '构成形容词'], ['ous', '构成形容词：充满…的'], ['ful', '构成形容词：充满…的'],
    ['less', '构成形容词：没有…的'], ['able', '构成形容词：可…的'], ['ible', '构成形容词：可…的'],
    ['ary', '构成形容词/名词'], ['ant', '构成形容词/名词'], ['ent', '构成形容词/名词'],
    ['ize', '构成动词：使…'], ['ise', '构成动词：使…'], ['ify', '构成动词：使…'],
    ['ate', '构成动词/形容词'], ['ly', '构成副词'], ['al', '构成形容词'],
    ['ic', '构成形容词'], ['en', '构成动词'], ['fy', '构成动词'],
    ['er', '构成名词：人/物'], ['or', '构成名词：人/物'], ['y', '构成名词/形容词'],
    ['s', '复数/第三人称']
  ];
  // 词干化用的后缀（比展示用的更宽一些）
  var STEM_SUFFIXES = ['ically','ological','ability','ibility','ation','ition','ology',
    'ography','graphy','ical','ancy','ency','ance','ence','ment','ness','ship','hood','ism','ist',
    'ity','tion','sion','ive','ous','ful','less','able','ible','ary','ant','ent',
    'ize','ise','ify','ate','ing','ed','ly','al','ic','en','er','or','fy','y','s'];

  function suffixesOf(word) {
    var w = String(word || '').toLowerCase();
    var out = [];
    for (var i = 0; i < SUFFIXES.length && out.length < 2; i++) {
      var sfx = SUFFIXES[i][0];
      if (w.length - sfx.length < 4 || w.slice(-sfx.length) !== sfx) continue;
      // 已经被更长的后缀包含（-ology 里的 -y）就不重复显示
      var overlap = false;
      for (var j = 0; j < out.length; j++) {
        if (out[j].suffix.slice(1).slice(-sfx.length) === sfx) { overlap = true; break; }
      }
      if (overlap) continue;
      out.push({ suffix: '-' + sfx, meaning: SUFFIXES[i][1] });
    }
    return out;
  }

  function stemOf(word) {
    var w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    if (w.length <= 5) return w;
    var changed = true, guard = 0;
    while (changed && guard++ < 4) {
      changed = false;
      for (var i = 0; i < STEM_SUFFIXES.length; i++) {
        var sfx = STEM_SUFFIXES[i];
        if (w.length - sfx.length >= 4 && w.slice(-sfx.length) === sfx) {
          w = w.slice(0, -sfx.length);
          changed = true;
          break;
        }
      }
    }
    return w;
  }

  function buildFamilies(list) {
    var map = {};
    (list || []).forEach(function (item) {
      var w = item.w || item;
      var k = stemOf(w);
      if (!k || k.length < 4) return;
      if (!map[k]) map[k] = [];
      if (w.indexOf(' ') === -1) map[k].push(item);
    });
    Object.keys(map).forEach(function (k) {
      if (map[k].length < 2) delete map[k];
    });
    return map;
  }

  /* ---------------- 词根 / 词缀提示 ---------------- */
  var ROOTS = [
    ['spect', '看'], ['spic', '看'], ['vis', '看'], ['vid', '看'],
    ['dict', '说'], ['duc', '引导'], ['duct', '引导'], ['port', '搬运'],
    ['mit', '送'], ['miss', '送'], ['fer', '带来'], ['pos', '放置'], ['pon', '放置'],
    ['struct', '建造'], ['form', '形状'], ['ject', '投掷'], ['tract', '拉'],
    ['press', '压'], ['tens', '伸展'], ['tend', '伸展'], ['vert', '转'], ['vers', '转'],
    ['volv', '滚'], ['mov', '动'], ['mot', '动'], ['gress', '走'], ['ced', '走'],
    ['ceed', '走'], ['cess', '走'], ['curr', '跑'], ['flu', '流'], ['grad', '步'],
    ['manu', '手'], ['ped', '脚'], ['pod', '脚'], ['cept', '拿'], ['cip', '拿'],
    ['tain', '握'], ['hibit', '拥有'], ['scrib', '写'], ['script', '写'],
    ['graph', '写'], ['gram', '写'], ['phon', '声音'], ['aud', '听'], ['log', '说/学'],
    ['sci', '知道'], ['cred', '相信'], ['fid', '信任'], ['sens', '感觉'], ['sent', '感觉'],
    ['path', '感受'], ['psych', '心灵'], ['bio', '生命'], ['geo', '土地'], ['terr', '土地'],
    ['aqua', '水'], ['mar', '海'], ['sol', '太阳'], ['astro', '星'], ['therm', '热'],
    ['chron', '时间'], ['ann', '年'], ['cycl', '圆'], ['medi', '中间'], ['centr', '中心'],
    ['fin', '界限'], ['term', '界限'], ['magn', '大'], ['micro', '小'], ['multi', '多'],
    ['mono', '单'], ['equ', '相等'], ['norm', '标准'], ['prim', '第一'], ['nov', '新'],
    ['brev', '短'], ['dur', '持久'], ['fort', '强'], ['val', '价值'], ['prob', '证明'],
    ['prov', '证明'], ['test', '证明'], ['jur', '法'], ['jud', '法'], ['leg', '法'],
    ['polit', '城邦'], ['civ', '公民'], ['popul', '人民'], ['soci', '社会'], ['cult', '耕作'],
    ['agr', '田地'], ['urb', '城市'], ['serv', '服务'], ['labor', '劳动'], ['oper', '工作'],
    ['fact', '做'], ['fect', '做'], ['crea', '创造'], ['gen', '产生'], ['nat', '出生'],
    ['mater', '母'], ['patr', '父'], ['temp', '时间'], ['vit', '生命'], ['mort', '死']
  ];
  var PREFIXES = [
    ['inter', '之间'], ['intro', '向内'], ['extra', '额外'], ['contra', '相反'], ['super', '上'],
    ['trans', '跨'], ['under', '不足'], ['micro', '微'], ['macro', '大'], ['multi', '多'],
    ['semi', '半'], ['anti', '反对'], ['auto', '自己'], ['tele', '远'], ['post', '后'],
    ['over', '过度'], ['pre', '预先'], ['pro', '向前'], ['con', '共同'], ['com', '共同'],
    ['dis', '分开/不'], ['sub', '下'], ['per', '贯穿'], ['mis', '错误'], ['non', '非'],
    ['out', '超过'], ['ex', '向外'], ['in', '向内'], ['im', '向内'], ['re', '回/再'],
    ['de', '向下/去除'], ['ad', '朝向'], ['ac', '朝向'], ['ab', '离开'], ['ob', '反对'],
    ['co', '共同'], ['un', '不'], ['bi', '二'], ['tri', '三'], ['uni', '单'], ['e', '向外']
  ];

  function explain(word) {
    var w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    if (w.length < 4) return null;

    var best = null;
    for (var i = 0; i < ROOTS.length; i++) {
      var r = ROOTS[i], at = w.indexOf(r[0]);
      if (at < 0) continue;
      var score = r[0].length * 10 - Math.min(at, 6);
      if (!best || score > best.score) best = { root: r[0], meaning: r[1], at: at, score: score };
    }
    if (!best) return null;

    var pre = null;
    for (var j = 0; j < PREFIXES.length; j++) {
      var p = PREFIXES[j];
      if (w.indexOf(p[0]) === 0 && w.length - p[0].length >= 4) {
        if (!pre) pre = p;
      }
    }
    // 单字母前缀太容易误判，必须是紧贴词根
    if (pre && pre[0].length === 1 && best.at !== 1) pre = null;
    if (pre && best.at === 0) pre = null;

    return {
      root: best.root,
      meaning: best.meaning,
      prefix: pre ? pre[0] : '',
      prefixMeaning: pre ? pre[1] : '',
      text: pre ? pre[0] + '（' + pre[1] + '）+ ' + best.root + '（' + best.meaning + '）'
                : best.root + '（' + best.meaning + '）'
    };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  global.Core = {
    dateKey: dateKey, todayKey: todayKey, addDays: addDays, daysBetween: daysBetween, cnDate: cnDate, weekdayCN: weekdayCN,
    blankRec: blankRec, keyOf: keyOf, recOf: recOf, isSeen: isSeen, isDue: isDue, review: review, statusOf: statusOf, fmtDue: fmtDue,
    allWords: allWords, firstUnfinishedGroup: firstUnfinishedGroup, planFor: planFor,
    streak: streak, recentDays: recentDays, mastery: mastery,
    THEMES: THEMES, guessTheme: guessTheme, groupInto20: groupInto20, chunk: chunk,
    parseWordList: parseWordList, escapeHtml: escapeHtml, explain: explain,
    suffixesOf: suffixesOf, stemOf: stemOf, buildFamilies: buildFamilies
  };
})(typeof window !== 'undefined' ? window : this);
