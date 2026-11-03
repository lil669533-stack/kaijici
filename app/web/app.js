/* 开机词 · 界面与交互 */
(function () {
  'use strict';

  var C = window.Core;
  var LS_STATE = 'kaijici.state.v1';
  var LS_THEME = 'kaijici.theme';

  var APP = {
    online: true,
    state: null,
    deck: null,
    index: {},
    view: 'today',
    session: null,
    quiz: null,
    preview: null,
    groupId: null,
    revealed: false,
    spell: null,
    nbId: null,
    nbRenaming: false,
    stemCache: {},
    exCache: {},
    exLoading: {},
    today: C.todayKey(),
    saveTimer: null,
    warned: false
  };
  window.__kaijici = APP;

  var ICON = {
    speaker: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.6L13 19V5L7.6 9.5H4z"/><path d="M16.5 8.8a4.6 4.6 0 0 1 0 6.4"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>'
  };

  /* ================= 存储 ================= */

  function defaultState() {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      deck: null,
      progress: {},
      days: {},
      notebooks: [],
      settings: { perDay: 20, reviewLimit: 40, autoplay: true, listen: false, spell: true }
    };
  }

  function normalize(s) {
    s.progress = s.progress || {};
    s.days = s.days || {};
    s.notebooks = s.notebooks || [];
    if (!s.notebooks.length && s.notebook && s.notebook.length) {
      s.notebooks.push({ id: 'nb-legacy', name: '我的生词本', words: s.notebook, created: (s.notebook[s.notebook.length - 1] || {}).added || C.todayKey() });
    }
    s.notebook = undefined;
    s.settings = Object.assign({ perDay: 20, reviewLimit: 40, autoplay: true, listen: false, spell: true }, s.settings || {});
    Object.keys(s.progress).forEach(function (k) {
      s.progress[k] = Object.assign(C.blankRec(), s.progress[k]);
    });
    return s;
  }

  function fetchState() {
    return fetch('api/state', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('bad status');
      return r.json();
    });
  }

  function loadState() {
    return fetchState().catch(function () {
      APP.online = false;
      try { return JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) { return null; }
    });
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url);
      return r.json();
    });
  }

  function ensureDeck() {
    var cur = APP.state.deck;
    // 用户自己导入的词库存在进度里；内置 / 词汇书词库每次从 data/ 重新读取
    if (cur && cur.meta && cur.meta.builtin === false && cur.groups && cur.groups.length) return Promise.resolve();
    return fetchJson('data/deck-book.json').catch(function () {
      return fetchJson('data/deck.json');
    }).then(function (d) {
      APP.state.deck = d;
    }).catch(function (e) {
      if (!cur || !cur.groups || !cur.groups.length) throw e;
    });
  }

  function save() {
    clearTimeout(APP.saveTimer);
    APP.saveTimer = setTimeout(flush, 300);
  }

  function flush() {
    var body = JSON.stringify(APP.state);
    if (!APP.online) {
      try { localStorage.setItem(LS_STATE, body); } catch (e) {}
      return;
    }
    fetch('api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function (r) {
      if (!r.ok) throw new Error('save failed');
    }).catch(function () {
      APP.online = false;
      try { localStorage.setItem(LS_STATE, body); } catch (e) {}
      if (!APP.warned) {
        APP.warned = true;
        toast('进度已暂存到浏览器，本地服务恢复后会继续保存');
      }
    });
  }

  /* ================= 工具 ================= */

  function esc(s) { return C.escapeHtml(s); }
  function $(id) { return document.getElementById(id); }
  function settings() { return APP.state.settings; }
  function eqi(k) { return APP.index[k]; }

  function byWord(word) {
    return (APP.byWord && APP.byWord[String(word).toLowerCase()]) || null;
  }

  function hydrateExample(w) {
    var key = C.keyOf(w);
    if (!w || w.ex || APP.exCache[key] || APP.exLoading[key]) return;
    APP.exLoading[key] = true;
    lookupWord(w.w).then(function (info) {
      if (info && info.ex) {
        APP.exCache[key] = { ex: info.ex, exCn: info.exCn || '' };
        var s = APP.session;
        if (s && s.queue[s.pos] && C.keyOf(s.queue[s.pos].w) === key && APP.revealed) render();
      }
    }).catch(function () {}).then(function () { APP.exLoading[key] = false; });
  }

  function hydrateStem() {
    var el = document.getElementById('stemInfo');
    if (!el) return;
    var stem = el.getAttribute('data-stem');
    if (!stem) return;
    if (APP.stemCache[stem]) {
      el.textContent = APP.stemCache[stem];
      el.classList.remove('stem-pending');
      return;
    }
    lookupWord(stem).then(function (info) {
      var txt = stem + ' = ' + ((info.cn || '').slice(0, 46) || '—');
      APP.stemCache[stem] = txt;
      var now = document.getElementById('stemInfo');
      if (now && now.getAttribute('data-stem') === stem) {
        now.textContent = txt;
        now.classList.remove('stem-pending');
      }
    }).catch(function () {
      var now = document.getElementById('stemInfo');
      if (now && now.getAttribute('data-stem') === stem) now.textContent = stem;
    });
  }

  function familyOf(word) {
    var k = C.stemOf(word);
    var list = APP.families && APP.families[k];
    if (!list) return [];
    var wl = String(word).toLowerCase();
    return list.filter(function (x) { return String(x.w).toLowerCase() !== wl; })
      .sort(function (a, b) { return String(a.w).length - String(b.w).length; })
      .slice(0, 3);
  }

  function dayRec() {
    return APP.state.days[APP.today] || { newDone: 0, reviewDone: 0 };
  }

  function totalCount() { return C.allWords(APP.deck).length; }

  function learnedCount() {
    var n = 0;
    C.allWords(APP.deck).forEach(function (x) {
      if (C.isSeen(APP.state.progress[C.keyOf(x.w)])) n++;
    });
    return n;
  }

  function dueWords() {
    return C.allWords(APP.deck).filter(function (x) {
      return C.isDue(APP.state.progress[C.keyOf(x.w)], APP.today);
    }).map(function (x) { return x.w; });
  }

  function weakWords() {
    return C.allWords(APP.deck).filter(function (x) {
      var r = APP.state.progress[C.keyOf(x.w)];
      return r && r.seen > 0 && (r.lapses > 0 || r.ease < 2.3);
    }).map(function (x) { return x.w; });
  }

  function currentPlan() {
    var d = dayRec();
    var perDay = (settings().perDay || 20) * (1 + (d.extra || 0));
    return C.planFor(APP.deck, APP.state.progress, APP.state.days, APP.today, {
      perDay: perDay,
      reviewLimit: settings().reviewLimit || 40
    });
  }

  function greeting() {
    var h = new Date().getHours();
    if (h < 5) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function uniq(a) {
    var seen = {}, out = [];
    a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  var speaking = false;
  var gestureArmed = false;

  // 浏览器要求先有一次交互才允许发声：没发出声音时，等第一次点击再补读
  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    var fire = function () {
      document.removeEventListener('pointerdown', fire, true);
      document.removeEventListener('keydown', fire, true);
      gestureArmed = false;
      var s = APP.session;
      if (s && s.queue && s.queue[s.pos]) {
        speak(s.queue[s.pos].w.w);
        APP.spokenTag = s.queue[s.pos].w.w + '@' + s.pos;
      }
    };
    document.addEventListener('pointerdown', fire, true);
    document.addEventListener('keydown', fire, true);
  }

  var lastSpeakAt = 0;
  var currentAudio = null;

  function speakViaServer(text) {
    fetch('api/speak?q=' + encodeURIComponent(text)).catch(function () {});
  }

  function speak(text) {
    text = String(text || '').trim();
    if (!text) return;
    var now = Date.now();
    if (now - lastSpeakAt < 80) return;   // 同一瞬间的重复调用只读一次
    lastSpeakAt = now;

    // 优先用有道的真人发音；播不了（自动播放被拦/离线）再退回系统语音
    try {
      if (currentAudio) { currentAudio.pause(); currentAudio = null; }
      var a = new Audio('api/audio?q=' + encodeURIComponent(text));
      var settled = false;
      a.onplaying = function () { settled = true; };
      a.onerror = function () { if (!settled) { settled = true; speakViaServer(text); } };
      currentAudio = a;
      var p = a.play();
      if (p && p.catch) p.catch(function () { if (!settled) { settled = true; speakViaServer(text); } });
    } catch (e) {
      speakViaServer(text);
    }
  }

  function speakCurrent() {
    var s = APP.session;
    if (!s || !s.queue[s.pos]) return;
    speak(s.queue[s.pos].w.w);
  }

  /* ================= 会话 ================= */

  function buildSession(plan, mode) {
    var queue = [];
    (plan.review || []).forEach(function (w) { queue.push({ w: w, mode: 'review' }); });
    if (mode !== 'review') {
      (plan.fresh || []).forEach(function (w) { queue.push({ w: w, mode: 'new' }); });
    }
    return { mode: mode, queue: queue, pos: 0, graded: 0, started: Date.now(), plan: plan };
  }

  function grade(g) {
    var s = APP.session;
    if (!s || !APP.revealed || s.pos >= s.queue.length) return;
    var card = s.queue[s.pos];
    var k = C.keyOf(card.w);
    var prev = APP.state.progress[k] || C.blankRec();
    var wasNew = !prev.seen;
    var firstToday = prev.last !== APP.today;

    APP.state.progress[k] = C.review(prev, g, APP.today);

    if (firstToday) {
      var d = dayRec();
      if (wasNew) d.newDone += 1; else d.reviewDone += 1;
      APP.state.days[APP.today] = d;
    }

    if (g === 'again' && (card.again || 0) < 2) {
      var again = { w: card.w, mode: card.mode, again: (card.again || 0) + 1 };
      s.queue.push(again);
    }

    APP.revealed = false;

    // 点了「认识」之后，先手打一遍（单词和短语都练）
    if (g === 'good' && settings().spell) {
      APP.spell = { card: card, typed: '', checked: false, ok: false };
      save();
      render();
      speak(card.w.w);   // 进入拼写时再读一遍，确认发音
      return;
    }

    s.pos += 1;
    s.graded += 1;
    save();
    render();
  }

  function checkSpell() {
    var sp = APP.spell;
    if (!sp || sp.checked) return;
    var input = document.getElementById('spellInput');
    var typed = input ? input.value : sp.typed;
    sp.typed = typed;
    var norm = function (x) {
      return String(x).toLowerCase().replace(/[\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
    };
    var target = norm(sp.card.w.w);
    var got = norm(typed);
    sp.checked = true;
    sp.ok = got === target && got.length > 0;
    render();
    if (sp.ok) {
      setTimeout(function () {
        if (APP.spell === sp) advanceAfterSpell();
      }, 700);
    }
  }

  function advanceAfterSpell() {
    var s = APP.session;
    if (!s) return;
    APP.spell = null;
    s.pos += 1;
    s.graded += 1;
    APP.revealed = false;
    save();
    render();
  }

  function diffHTML(typed, target) {
    var a = String(typed), b = String(target);
    if (!a.length) {
      return '<div class="diff"><div class="diff-row"><span class="diff-label">你写的</span>' +
        '<span class="diff-text empty">（没写）</span></div>' +
        '<div class="diff-row"><span class="diff-label">正确</span><span class="diff-text"><i class="good">' +
        esc(b) + '</i></span></div></div>';
    }
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a.charAt(i).toLowerCase() === b.charAt(i).toLowerCase()) i++;
    var head = esc(b.slice(0, i));
    var tailA = a.slice(i), tailB = b.slice(i);
    return '<div class="diff">' +
      '<div class="diff-row"><span class="diff-label">你写的</span><span class="diff-text">' + head +
        (tailA ? '<i class="bad">' + esc(tailA) + '</i>' : '<i class="bad">（少写了）</i>') + '</span></div>' +
      '<div class="diff-row"><span class="diff-label">正确</span><span class="diff-text">' + head +
        '<i class="good">' + esc(tailB) + '</i></span></div>' +
    '</div>';
  }

  function startReview() {
    var due = dueWords();
    if (!due.length) { toast('今天没有到期的复习词'); return; }
    var plan = { review: due.slice(0, settings().reviewLimit || 40), fresh: [] };
    APP.session = buildSession(plan, 'review');
    APP.revealed = false;
    render();
  }

  function startWeak() {
    var weak = weakWords().slice(0, 40);
    if (!weak.length) { toast('还没有需要强化的词'); return; }
    APP.session = buildSession({ review: weak, fresh: [] }, 'weak');
    APP.revealed = false;
    render();
  }

  function extraGroup() {
    var d = dayRec();
    d.extra = (d.extra || 0) + 1;
    APP.state.days[APP.today] = d;
    var plan = currentPlan();
    if (!plan.fresh.length) { toast('词库里的新词已经学完了'); return; }
    APP.session = buildSession(plan, 'today');
    APP.session.plan = plan;
    APP.revealed = false;
    save();
    render();
  }

  /* ================= 视图 ================= */

  function render() {
    if (!APP.state) return;
    var root = $('app');
    if (APP.view === 'today') renderToday(root);
    else if (APP.view === 'review') renderReview(root);
    else if (APP.view === 'deck') renderDeck(root);
    else if (APP.view === 'notebook') renderNotebookList(root);
    else if (APP.view === 'notebook-detail') renderNotebookDetail(root);
    else if (APP.view === 'quiz') renderQuiz(root);
    else if (APP.view === 'stats') renderStats(root);
    else if (APP.view === 'import') renderImport(root);
    else if (APP.view === 'group') renderGroup(root);
    updateChrome();

    hydrateStem();

    if ((APP.view === 'today' || APP.view === 'review' || APP.view === 'notebook' || APP.view === 'notebook-detail') &&
        APP.revealed && APP.session && APP.session.queue[APP.session.pos]) {
      hydrateExample(APP.session.queue[APP.session.pos].w);
    }

    if (APP.spell && !APP.spell.checked) {
      var si = document.getElementById('spellInput');
      if (si) si.focus();
    }

    if ((APP.view === 'today' || APP.view === 'review' || APP.view === 'notebook' || APP.view === 'notebook-detail') && APP.session &&
        (settings().autoplay || settings().listen)) {
      var s = APP.session;
      if (s.pos < s.queue.length) {
        var tag = s.queue[s.pos].w.w + '@' + s.pos;
        if (APP.spokenTag !== tag) { APP.spokenTag = tag; speak(s.queue[s.pos].w.w); }
      }
    }
  }

  function updateChrome() {
    $('sideStreak').textContent = C.streak(APP.state.days, APP.today);
    $('sideDue').textContent = '今日待复习 ' + dueWords().length;
    var nav = $('nav').querySelectorAll('button');
    for (var i = 0; i < nav.length; i++) {
      var want = APP.view === 'notebook-detail' ? 'notebook' : APP.view;
      nav[i].classList.toggle('active', nav[i].getAttribute('data-view') === want);
    }
  }

  /* ---------- 今日 ---------- */

  function renderToday(root) {
    var perDay = settings().perDay || 20;
    var head =
      '<div class="page-head">' +
        '<div>' +
          '<p class="kicker">' + C.cnDate(APP.today) + '</p>' +
          '<h1>' + greeting() + '，今天 <span class="soft">' + perDay + ' 个词</span></h1>' +
        '</div>' +
        '<div class="head-stats">' +
          '<span class="pill">🔥 连续 <b>' + C.streak(APP.state.days, APP.today) + '</b> 天</span>' +
          '<span class="pill accent">已学 <b>' + learnedCount() + '</b> / ' + totalCount() + '</span>' +
        '</div>' +
      '</div>';

    var plan = currentPlan();
    var needBuild = !APP.session || APP.session.mode !== 'today';
    if (needBuild) {
      APP.session = buildSession(plan, 'today');
      APP.session.plan = plan;
    }
    var s = APP.session;

    var body;
    if (!s.queue.length || s.pos >= s.queue.length) {
      body = doneHTML(s);
    } else {
      body = studyLayout(s, plan);
    }
    root.innerHTML = head + body;
  }

  function studyLayout(s, plan) {
    var card = APP.spell ? spellHTML(s, APP.spell) : cardHTML(s);
    return '<div class="focus-grid">' + card + planHTML(plan, s) + '</div>';
  }

  function spellHTML(s, sp) {
    var w = sp.card.w;
    var total = s.queue.length;
    var feedback = '';
    if (sp.checked) {
      feedback = sp.ok
        ? '<div class="spell-ok">✓ 拼写正确，继续</div>'
        : diffHTML(sp.typed, w.w);
    }
    return '<section class="study-card spell-card">' +
      '<div class="card-top">' +
        '<span class="chip">拼写检查</span>' +
        '<span class="counter">' + (s.pos + 1) + '<i>/</i>' + total + '</span>' +
      '</div>' +
      '<div class="bar"><i style="width:' + Math.round((s.pos / total) * 100) + '%"></i></div>' +
      '<div class="card-body enter">' +
        '<div class="spell-q">' + (String(w.w).indexOf(' ') >= 0 ? '凭记忆拼出这个短语' : '凭记忆拼出这个词') + '</div>' +
        '<div class="spell-cn">' + esc(w.cn) + '</div>' +
        '<input id="spellInput" class="spell-input' + (sp.checked && !sp.ok ? ' bad' : '') + '" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
          'value="' + esc(sp.typed) + '"' + (sp.checked ? ' disabled' : '') + ' placeholder="输入英文，回车确认">' +
        feedback +
      '</div>' +
      '<div class="actions">' +
        (sp.checked
          ? (sp.ok ? '' : '<button class="btn primary" data-action="spell-next">下一个词 <kbd>回车</kbd></button>')
          : '<button class="btn primary" data-action="spell-check">检查拼写 <kbd>回车</kbd></button>') +
      '</div>' +
    '</section>';
  }

  function planHTML(plan, s) {
    var d = dayRec();
    var perDay = settings().perDay || 20;
    var rest = (s && s.queue) ? s.queue.slice(s.pos) : [];
    var leftReview = rest.length ? rest.filter(function (c) { return c.mode === 'review'; }).length : dueWords().length;
    var leftNew = rest.length ? rest.filter(function (c) { return c.mode === 'new'; }).length : Math.max(0, perDay - (d.newDone || 0));
    var g = plan.group;
    return '<aside class="plan-card">' +
      '<div class="plan-title">今日计划</div>' +
      '<div class="plan-nums">' +
        '<div><b>' + Math.max(0, leftReview) + '</b><span>待复习</span></div>' +
        '<div><b>' + leftNew + '</b><span>待新学</span></div>' +
      '</div>' +
      (g ?
        '<div class="plan-group"><div class="k">当前分组</div><div class="v">' + esc(g.title) + '</div><p>' + esc(g.hint || '') + '</p></div>'
        : '<div class="plan-group"><div class="k">当前分组</div><div class="v">全部学完</div><p>接下来靠复习巩固：每天把到期的词过一遍就好。</p></div>') +
      '<div class="tip">💡 先看词根或场景，猜一下意思，再点开答案——猜错的那次记得最牢。</div>' +
    '</aside>';
  }

  function cardHTML(s) {
    var card = s.queue[s.pos];
    var w = card.w;
    var total = s.queue.length;
    var gi = eqi(C.keyOf(w));
    var g = APP.deck.groups[gi];
    var inBook = APP.session && APP.session.mode === 'notebook';
    var label = inBook ? ('生词本 · ' + (APP.session.nbName || '')) : ((card.mode === 'new' ? '新词' : '复习') + (g ? ' · ' + g.title : ''));

    var answer = '';
    if (APP.revealed) {
      var rows = [];
      var wfRow = function (tag, text) {
        return '<div class="wf-row"><b>' + tag + '</b><span>' + text + '</span></div>';
      };
      var ex = C.explain(w.w);
      if (w.root) {
        rows.push(wfRow('词根', esc(w.root)));
      } else if (ex) {
        rows.push(wfRow('词根', esc(ex.root + ' = ' + ex.meaning)));
      }

      var stem = C.stemOf(w.w);
      if (stem && stem !== String(w.w).toLowerCase() && stem.length >= 4) {
        var base = byWord(stem);
        if (base) {
          rows.push(wfRow('词干', esc(base.w + ' = ' + String(base.cn || '').slice(0, 46))));
        } else if (!ex) {
          rows.push(wfRow('词干', '<span id="stemInfo" class="stem-pending" data-stem="' + esc(stem) + '">正在查询 ' + esc(stem) + '…</span>'));
        }
      }

      C.suffixesOf(w.w).forEach(function (sf) {
        rows.push(wfRow('后缀', esc(sf.suffix + ' = ' + sf.meaning)));
      });
      var fam = familyOf(w.w);
      if (!fam.length && w.rel && w.rel.length) {
        fam = w.rel.map(function (r) { return { w: r.w, pos: r.pos, cn: r.cn }; });
      }
      fam = fam.filter(function (f) { return String(f.w).toLowerCase() !== stem; });
      if (fam.length) {
        rows.push(wfRow('派生', fam.map(function (f) {
          return '<button type="button" class="fam-word" data-action="speak-word" data-w="' + esc(f.w) + '" title="点击朗读">' +
            esc(f.w) + (f.pos ? '（' + esc(f.pos) + '）' : '') + ' ' + esc(f.cn || '') + '</button>';
        }).join('<span class="fam-sep">·</span>')));
      }
      if (w.note) rows.push(wfRow('关联', esc(w.note)));
      var hint = rows.length ? '<div class="wf">' + rows.join('') + '</div>' : '';
      hint += '<div class="nb-save"><button class="btn small" data-action="add-notebook" data-w="' + esc(w.w) + '" data-cn="' + esc(w.cn || '') + '">＋ 加入生词本</button></div>';
      var exKey = C.keyOf(w);
      var cachedEx = APP.exCache[exKey];
      var exEn = w.ex || (cachedEx && cachedEx.ex) || '';
      var exCn = w.exCn || (cachedEx && cachedEx.exCn) || '';
      answer = '<div class="answer">' +
        '<div class="def">' + (w.pos || w.w.indexOf(' ') >= 0 ? '<span class="pos">' + esc(w.pos || '词组') + '</span>' : '') +
          '<span class="cn">' + esc(w.cn) + '</span></div>' +
        (exEn ? '<div class="ex">' + esc(exEn) + '</div>' : '') +
        (exCn ? '<div class="ex-cn">' + esc(exCn) + '</div>' : '') +
        hint +
      '</div>';
    }

    var actions = APP.revealed
      ? '<div class="grades">' +
          '<button class="grade g1" data-action="grade" data-grade="again"><span>不认识</span><small><kbd>1</kbd></small></button>' +
          '<button class="grade g2" data-action="grade" data-grade="hard"><span>模糊</span><small><kbd>2</kbd></small></button>' +
          '<button class="grade g3" data-action="grade" data-grade="good"><span>认识</span><small><kbd>3</kbd></small></button>' +
        '</div>'
      : '<button class="btn primary" data-action="reveal">显示答案 <kbd>空格</kbd></button>';

    return '<section class="study-card">' +
      '<div class="card-top">' +
        '<span class="chip">' + esc(label) + '</span>' +
        '<span class="counter">' + (s.pos + 1) + '<i>/</i>' + total + '</span>' +
      '</div>' +
      '<div class="bar"><i style="width:' + Math.round((s.pos / total) * 100) + '%"></i></div>' +
      '<div class="card-body enter">' +
        (settings().listen && !APP.revealed
          ? '<div class="word masked">· · · ·</div><div class="ipa-row"><span class="ipa">先听发音，回忆拼写</span>' +
            '<button class="speak" data-action="speak" aria-label="朗读">' + ICON.speaker + '</button></div>'
          : '<div class="word">' + esc(w.w) + '</div><div class="ipa-row">' + (w.ipa ? '<span class="ipa">' + esc(String(w.ipa).charAt(0) === '/' ? w.ipa : '/' + w.ipa + '/') + '</span>' : '<span class="ipa">点喇叭听发音</span>') +
            '<button class="speak" data-action="speak" aria-label="朗读">' + ICON.speaker + '</button></div>') +
        answer +
      '</div>' +
      '<div class="actions">' + actions + '</div>' +
    '</section>';
  }

  function doneHTML(s) {
    var d = dayRec();
    var next = C.firstUnfinishedGroup(APP.deck, APP.state.progress);
    var minutes = s && s.started ? Math.max(1, Math.round((Date.now() - s.started) / 60000)) : 0;
    var noWords = !next;

    return '<div class="done-card">' +
      '<div class="done-mark">' + ICON.check + '</div>' +
      '<h2>' + (noWords ? '整本词库都过了一遍' : '今天这一组完成了') + '</h2>' +
      '<p>' + (noWords ? '接下来每天回来复习到期的词，别让它们凉掉。' : '合上电脑也可以，明天开机再见。') + '</p>' +
      '<div class="done-stats">' +
        '<div><b>' + (d.newDone || 0) + '</b><span>今日新学</span></div>' +
        '<div><b>' + (d.reviewDone || 0) + '</b><span>今日复习</span></div>' +
        '<div><b>' + C.streak(APP.state.days, APP.today) + '</b><span>连续天数</span></div>' +
      '</div>' +
      '<div class="done-actions">' +
        '<button class="btn primary" data-action="quiz-start">做 10 道小测</button>' +
        (next ? '<button class="btn" data-action="extra">再来一组</button>' : '') +
        '<button class="btn" data-action="go-deck">看看词库</button>' +
      '</div>' +
      (minutes ? '<p style="margin-top:14px;font-size:11.5px">这组大约花了 ' + minutes + ' 分钟</p>' : '') +
    '</div>';
  }

  /* ---------- 复习 ---------- */

  function renderReview(root) {
    var s = APP.session;
    if (s && (s.mode === 'review' || s.mode === 'weak')) {
      var head = '<div class="page-head"><div><p class="kicker">' +
        (s.mode === 'review' ? '到期的词' : '薄弱词') + '</p><h1>复习 <span class="soft">' +
        s.queue.length + ' 个词</span></h1></div>' +
        '<div class="head-stats"><span class="pill accent">第 <b>' + Math.min(s.pos + 1, s.queue.length) + '</b> / ' + s.queue.length + '</span></div></div>';
      if (s.pos >= s.queue.length) {
        root.innerHTML = head + '<div class="done-card"><div class="done-mark">' + ICON.check + '</div>' +
          '<h2>复习完成</h2><p>这次过了 ' + s.graded + ' 个词，明天见。</p>' +
          '<div class="done-actions" style="margin-top:18px">' +
          '<button class="btn primary" data-action="quiz-start">做 10 道小测</button>' +
          '<button class="btn" data-action="review-back">返回复习首页</button></div></div>';
        return;
      }
      root.innerHTML = head + '<div class="focus-grid">' + (APP.spell ? spellHTML(s, APP.spell) : cardHTML(s)) + '<aside class="plan-card">' +
        '<div class="plan-title">' + (s.mode === 'review' ? '到期复习' : '薄弱词强化') + '</div>' +
        '<div class="plan-nums"><div><b>' + (s.queue.length - s.pos) + '</b><span>还剩</span></div>' +
        '<div><b>' + s.graded + '</b><span>已过</span></div></div>' +
        '<div class="plan-group"><div class="k">提示</div><p>' +
        (s.mode === 'review' ? '这些词到了该见面的时候。想不起来别硬撑，选“不认识”它会很快再来。' : '这些是你之前点过“不认识”或“模糊”的词，重点关照。') +
        '</p></div></aside></div>';
      return;
    }

    var due = dueWords();
    var weak = weakWords();
    root.innerHTML =
      '<div class="page-head"><div><p class="kicker">间隔复习</p><h1>需要再见一面的词</h1></div>' +
      '<div class="head-stats"><span class="pill">🔁 今天到期 <b>' + due.length + '</b></span></div></div>' +
      '<div class="focus-grid">' +
        '<div class="study-card" style="min-height:auto;gap:14px">' +
          '<div class="card-top"><span class="chip">到期复习</span><span class="counter">' + due.length + ' 词</span></div>' +
          (due.length
            ? '<p style="color:var(--ink-2);font-size:14px;margin:18px 0">按记忆曲线，这 ' + due.length + ' 个词今天该复习了。一次最多过 ' + (settings().reviewLimit || 40) + ' 个。</p>' +
              '<button class="btn primary" data-action="start-review">开始复习</button>'
            : '<div style="padding:34px 0;text-align:center;color:var(--muted);font-size:13.5px">今天没有到期的词 ✨<br><span style="font-size:12px">去学新的一组，或者做个小测</span></div>' +
              '<button class="btn" data-action="quiz-start">做小测</button>') +
        '</div>' +
        '<aside class="plan-card">' +
          '<div class="plan-title">薄弱词</div>' +
          '<div class="plan-nums"><div><b>' + weak.length + '</b><span>需要强化</span></div>' +
          '<div><b>' + C.streak(APP.state.days, APP.today) + '</b><span>连续天数</span></div></div>' +
          '<div class="plan-group"><div class="k">怎么判定</div><p>之前点过“不认识”，或者记忆难度偏高的词会出现在这里。</p></div>' +
          (weak.length ? '<button class="btn small" data-action="start-weak">练这 ' + Math.min(weak.length, 40) + ' 个词</button>' : '') +
        '</aside>' +
      '</div>';
  }

  /* ---------- 词库 ---------- */

  function groupCard(g, i) {
    var done = 0;
    g.words.forEach(function (w) { if (C.isSeen(APP.state.progress[C.keyOf(w)])) done++; });
    var pct = Math.round((done / g.words.length) * 100);
    return '<button class="group-card" data-action="open-group" data-id="' + i + '">' +
      '<div class="g-title"><span>' + esc(g.title) + '</span><span class="n">' + done + '/' + g.words.length + '</span></div>' +
      '<div class="mini-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="g-meta"><span>第 ' + (i + 1) + ' 组</span><span>' + pct + '%</span></div>' +
    '</button>';
  }

  function renderDeck(root) {
    var groups = APP.deck.groups || [];
    var total = totalCount();
    var learned = learnedCount();
    var meta = APP.deck.meta || {};
    var units = meta.units || [];

    var body = '';
    if (units.length) {
      units.forEach(function (u) {
        var idx = [];
        groups.forEach(function (g, i) { if (g.unit === u.name) idx.push(i); });
        if (!idx.length) return;
        body += '<div class="unit-block"><div class="unit-head"><h2>' + esc(u.name) + '</h2>' +
          '<span>' + (u.total || idx.length * 20) + ' 词 · ' + idx.length + ' 组</span></div>' +
          '<div class="group-grid">' + idx.map(function (i) { return groupCard(groups[i], i); }).join('') + '</div></div>';
      });
    } else {
      body = '<div class="group-grid">' + groups.map(groupCard).join('') + '</div>';
    }

    root.innerHTML =
      '<div class="page-head"><div><p class="kicker">' + esc(meta.name || '我的词库') + '</p>' +
      '<h1>词库 <span class="soft">' + (units.length ? units.length + ' 个场景 · ' : '') + groups.length + ' 组 · ' + total + ' 词</span></h1></div>' +
      '<div class="head-stats"><span class="pill accent">已学 <b>' + learned + '</b></span>' +
      '<span class="pill">剩余 <b>' + (total - learned) + '</b></span></div></div>' +
      body;
  }

  function renderGroup(root) {
    var gi = APP.groupId;
    var g = APP.deck.groups[gi];
    if (!g) { APP.view = 'deck'; render(); return; }
    var rows = g.words.map(function (w) {
      var rec = C.recOf(APP.state.progress, w);
      var st = C.statusOf(rec);
      var stText = st === 'new' ? '未学' : (st === 'mastered' ? '已掌握' : C.fmtDue(rec, APP.today));
      return '<div class="word-row">' +
        '<div class="w">' + esc(w.w) + (w.ipa ? '<small>' + esc(w.ipa) + '</small>' : '') + '</div>' +
        '<div class="m">' + esc(w.cn) + '</div>' +
        '<div class="st ' + st + '">' + esc(stText) + '</div>' +
      '</div>';
    }).join('');

    root.innerHTML =
      '<button class="back-btn" data-action="back-deck">' + ICON.left + ' 返回词库</button>' +
      '<div class="page-head"><div><p class="kicker">第 ' + (gi + 1) + ' 组</p><h1>' + esc(g.title) + '</h1>' +
      '<p style="color:var(--muted);font-size:13px;margin:8px 0 0;max-width:640px">' + esc(g.hint || '') + '</p></div></div>' +
      '<div class="word-list">' + rows + '</div>';
  }

  /* ---------- 生词本（可多本） ---------- */

  function nbFind(id) {
    var list = APP.state.notebooks || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function nbNewId() { return 'nb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  function addNotebook(word, cn, note, src, info) {
    word = String(word || '').trim();
    if (!word) return null;
    var nb = nbFind(APP.nbId) || (APP.state.notebooks || [])[0];
    if (!nb) {
      nb = { id: nbNewId(), name: '我的生词本', words: [], created: APP.today };
      APP.state.notebooks.push(nb);
    }
    for (var i = 0; i < nb.words.length; i++) {
      if (nb.words[i].w.toLowerCase() === word.toLowerCase()) {
        toast('「' + nb.name + '」里已经有这个词了');
        return null;
      }
    }
    var entry = { w: word, cn: String(cn || '').trim(), note: String(note || '').trim(), added: APP.today, src: src || 'manual' };
    if (info) {
      entry.ipa = info.ipa || '';
      entry.pos = info.pos || '';
      var seen = {};
      entry.rel = (info.rel || []).filter(function (r) {
        if (!r || !r.w || seen[r.w]) return false;
        seen[r.w] = 1; return true;
      }).slice(0, 6);
    }
    nb.words.unshift(entry);
    save();
    return nb.name;
  }

  function lookupWord(word) {
    return fetch('api/lookup?q=' + encodeURIComponent(word), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('lookup'); return r.json(); })
      .then(function (d) {
        if (!d || d.ok === false) throw new Error('lookup');
        return d;
      });
  }

  function submitNotebookWord() {
    var wv = document.getElementById('nbWord');
    var cv = document.getElementById('nbCn');
    var word = (wv ? wv.value : '').trim();
    if (!word) return;
    var btn = document.querySelector('[data-action="nb-add"]');
    if (btn) { btn.disabled = true; btn.textContent = '查词中…'; }
    var typedCn = cv ? cv.value.trim() : '';

    lookupWord(word).then(function (info) {
      var cn = typedCn || (info && info.cn) || '';
      var nbName = addNotebook(word, cn, '', 'manual', info);
      if (nbName) {
        toast(info && (info.cn || info.rel && info.rel.length) ? '已加入「' + nbName + '」，释义和派生词已补全' : '已加入「' + nbName + '」');
      }
      render();
      var nw = document.getElementById('nbWord');
      if (nw) nw.focus();
    }).catch(function () {
      var nbName = addNotebook(word, typedCn, '', 'manual', null);
      if (nbName) toast('已加入（联网查询失败，可稍后补释义）');
      render();
    });
  }

  function renderNotebookList(root) {
    var books = APP.state.notebooks || [];
    var totalWords = books.reduce(function (n, b) { return n + b.words.length; }, 0);
    var cards = books.map(function (b) {
      var todayN = b.words.filter(function (x) { return x.added === APP.today; }).length;
      var preview = b.words.slice(0, 4).map(function (x) { return x.w; }).join(' · ');
      return '<button class="nb-card" data-action="nb-open" data-id="' + b.id + '">' +
        '<div class="nb-card-top"><span class="nb-name">' + esc(b.name) + '</span><span class="nb-count">' + b.words.length + ' 词</span></div>' +
        '<div class="nb-preview">' + (preview ? esc(preview) : '还没有词') + '</div>' +
        '<div class="nb-meta"><span>' + (todayN ? '今天 +' + todayN : '今天还没加词') + '</span><span>打开 →</span></div>' +
      '</button>';
    }).join('');

    root.innerHTML =
      '<div class="page-head"><div><p class="kicker">生词本</p><h1>我的生词本 <span class="soft">' + books.length + ' 本 · ' + totalWords + ' 词</span></h1></div>' +
      '<div class="head-stats"><span class="pill accent">今日新增 <b>' +
        books.reduce(function (n, b) { return n + b.words.filter(function (x) { return x.added === APP.today; }).length; }, 0) +
      '</b></span></div></div>' +
      '<div class="panel"><h3>新建一个生词本</h3>' +
        '<p class="desc">按来源分本，比如「雅思听力」「阅读真题」「口语素材」。</p>' +
        '<div class="nb-form"><input id="nbName" placeholder="生词本名称，如 雅思听力" autocomplete="off" maxlength="20">' +
        '<button class="btn primary small" data-action="nb-create">新建</button></div></div>' +
      (books.length
        ? '<div class="section-head"><h2>全部生词本 <span>' + books.length + ' 本</span></h2></div><div class="nb-grid">' + cards + '</div>'
        : '<div class="done-card" style="margin-top:14px"><h2>还没有生词本</h2><p>在上面起个名字，马上就能开始收集。</p></div>');
  }

  function renderNotebookDetail(root) {
    var nb = nbFind(APP.nbId);
    if (!nb) { APP.view = 'notebook'; render(); return; }
    var s = APP.session;
    var head = '<div class="page-head"><div><p class="kicker"><button class="back-btn" data-action="nb-list">' + ICON.left + ' 全部生词本</button></p>' +
      (APP.nbRenaming
        ? '<div class="nb-rename"><input id="nbRename" value="' + esc(nb.name) + '" maxlength="20">' +
          '<button class="btn primary small" data-action="nb-rename-save">保存</button>' +
          '<button class="btn small" data-action="nb-rename-cancel">取消</button></div>'
        : '<h1>' + esc(nb.name) + ' <span class="soft">' + nb.words.length + ' 词</span> ' +
          '<button class="btn small" data-action="nb-rename">改名</button></h1>') +
      '</div><div class="head-stats">' +
        '<button class="btn small" data-action="nb-delete">删除本</button></div></div>';

    if (s && s.mode === 'notebook' && s.nbId === nb.id) {
      if (s.pos >= s.queue.length) {
        root.innerHTML = head + '<div class="done-card"><div class="done-mark">' + ICON.check + '</div>' +
          '<h2>「' + esc(nb.name) + '」过完了</h2><p>这一轮过了 ' + s.graded + ' 个词。</p>' +
          '<div class="done-actions" style="margin-top:18px">' +
          '<button class="btn primary" data-action="nb-back">回到词本</button>' +
          '<button class="btn" data-action="nb-study" data-id="' + nb.id + '">再来一遍</button></div></div>';
        return;
      }
      root.innerHTML = head + '<div class="focus-grid">' +
        (APP.spell ? spellHTML(s, APP.spell) : cardHTML(s)) +
        '<aside class="plan-card"><div class="plan-title">生词本复习</div>' +
        '<div class="plan-nums"><div><b>' + (s.queue.length - s.pos) + '</b><span>还剩</span></div>' +
        '<div><b>' + s.graded + '</b><span>已过</span></div></div>' +
        '<div class="plan-group"><div class="k">提示</div><p>点「认识」后还要手打一遍，拼错会标红对比。</p></div>' +
        '<button class="btn small" data-action="nb-back">退出复习</button></aside></div>';
      return;
    }

    var rows = nb.words.map(function (x, i) {
      return '<div class="nb-row">' +
        '<div class="nb-w">' + esc(x.w) + '<small>' + esc(x.added || '') + '</small></div>' +
        '<div class="nb-m"><span class="nb-cn">' + esc(x.cn || '—') + '</span>' +
          (x.root ? '<div class="nb-root">' + esc(x.root) + '</div>' : '') +
          (x.ipa ? ' <span class="nb-ipa">/' + esc(x.ipa) + '/</span>' : '') +
          (x.note ? '<span>' + esc(x.note) + '</span>' : '') +
          ((x.rel && x.rel.length)
            ? '<div class="nb-rel">派生 ' + x.rel.slice(0, 3).map(function (r) {
                return '<button type="button" data-action="nb-speak" data-w="' + esc(r.w) + '">' + esc(r.w) + '</button>';
              }).join('') + '</div>'
            : '') +
        '</div>' +
        '<div class="nb-op">' +
          '<button class="icon-btn" data-action="nb-speak" data-w="' + esc(x.w) + '" title="朗读">' + ICON.speaker + '</button>' +
          '<button class="icon-btn danger" data-action="nb-del" data-i="' + i + '" title="删除">×</button>' +
        '</div></div>';
    }).join('');

    root.innerHTML = head +
      '<div class="panel nb-panel"><h3>收录一个生词</h3>' +
        '<p class="desc">做真题、看文章时遇到的词随手记；复习时和词库一样有间隔复习。</p>' +
        '<div class="nb-form">' +
          '<input id="nbWord" placeholder="单词，如 sustainable" autocomplete="off" spellcheck="false">' +
          '<input id="nbCn" placeholder="意思（可留空）" autocomplete="off">' +
          '<button class="btn primary small" data-action="nb-add">加入</button>' +
        '</div></div>' +
      (nb.words.length
        ? '<div class="section-head"><h2>已收录 <span>' + nb.words.length + ' 个词</span></h2>' +
          '<div class="nb-head-actions">' +
          (nb.words.some(function (x) { return !x.cn || x.cn === '—'; })
            ? '<button class="btn small" data-action="nb-enrich">补全释义</button>' : '') +
          '<button class="btn small" data-action="nb-study" data-id="' + nb.id + '">开始复习</button></div></div>' +
          '<div class="nb-list">' + rows + '</div>'
        : '<div class="done-card" style="margin-top:14px"><h2>这本还是空的</h2><p>在上面输入一个词，或者在背词时点「加入生词本」。</p></div>');
  }

  function enrichNotebook() {
    var nb = nbFind(APP.nbId);
    if (!nb) return;
    var todo = nb.words.filter(function (x) { return !x.cn || x.cn === '—'; });
    if (!todo.length) { toast('这本没有缺释义的词'); return; }
    var done = 0;
    function step() {
      if (done >= todo.length) {
        save(); render();
        toast('补全完成，共 ' + todo.length + ' 个词');
        return;
      }
      var entry = todo[done];
      lookupWord(entry.w).then(function (info) {
        if (info) {
          if (!entry.cn && info.cn) entry.cn = info.cn;
          if (!entry.ipa && info.ipa) entry.ipa = info.ipa;
          if (!entry.pos && info.pos) entry.pos = info.pos;
          if ((!entry.rel || !entry.rel.length) && info.rel && info.rel.length) entry.rel = info.rel.slice(0, 6);
        }
      }).catch(function () {}).then(function () {
        done += 1;
        save(); render();
        toast('正在补全 ' + done + ' / ' + todo.length);
        setTimeout(step, 300);
      });
    }
    step();
  }

  function startNotebookStudy(id) {
    var nb = nbFind(id) || nbFind(APP.nbId);
    if (!nb) return;
    var words = nb.words.slice();
    if (!words.length) { toast('这本还是空的'); return; }
    words.sort(function (a, b) {
      var ra = APP.state.progress[C.keyOf(a.w)] || {};
      var rb = APP.state.progress[C.keyOf(b.w)] || {};
      return String(ra.due || '0000-00-00').localeCompare(String(rb.due || '0000-00-00'));
    });
    APP.nbId = nb.id;
    APP.session = {
      mode: 'notebook', nbId: nb.id, nbName: nb.name,
      queue: words.map(function (x) {
        return { w: { w: x.w, cn: x.cn, note: x.note, ipa: x.ipa, pos: x.pos, rel: x.rel, root: x.root }, mode: 'new' };
      }),
      pos: 0, graded: 0, started: Date.now()
    };
    APP.revealed = false;
    APP.spell = null;
    APP.view = 'notebook-detail';
    render();
  }

  /* ---------- 测试 ---------- */

  function quizPool() {
    var all = C.allWords(APP.deck);
    var learned = all.filter(function (x) { return C.isSeen(APP.state.progress[C.keyOf(x.w)]); });
    return learned.length >= 8 ? learned : all;
  }

  function startQuiz(mode) {
    mode = mode || 'choice';
    var pool = quizPool();
    if (pool.length < 4) { toast('词库太小了，先学几个词吧'); return; }
    pool = shuffle(pool.slice()).slice(0, Math.min(10, pool.length));

    if (mode === 'dictation') {
      APP.quiz = {
        mode: 'dictation',
        qs: pool.map(function (x) { return { w: x.w }; }),
        i: 0, score: 0, answered: 0, checked: false, ok: false, typed: '', finished: false
      };
    } else {
      var meanings = uniq(C.allWords(APP.deck).map(function (x) { return x.w.cn; }));
      var qs = pool.map(function (x) {
        var others = shuffle(meanings.filter(function (m) { return m !== x.w.cn; })).slice(0, 3);
        return { w: x.w, options: shuffle(others.concat([x.w.cn])), answer: x.w.cn };
      });
      APP.quiz = { mode: 'choice', qs: qs, i: 0, score: 0, answered: 0, picked: null, finished: false };
    }
    APP.view = 'quiz';
    render();
    if (mode === 'dictation') setTimeout(speakQuizWord, 150);
    else if (settings().autoplay) setTimeout(speakQuizCurrent, 150);
  }

  function speakQuizCurrent() {
    var q = APP.quiz;
    if (!q || q.finished) return;
    var item = q.qs[q.i];
    if (item && item.w) speak(item.w.w);
  }

  function speakQuizWord() {
    var q = APP.quiz;
    if (!q || q.finished) return;
    var item = q.qs[q.i];
    if (!item) return;
    speak(item.w.w);
    var input = document.getElementById('dictInput');
    if (input) input.focus();
  }

  function quizResultHTML(q) {
    var rate = q.answered ? Math.round((q.score / q.answered) * 100) : 0;
    return '<div class="page-head"><div><p class="kicker">' + (q.mode === 'dictation' ? '拼写结果' : '自测结果') + '</p>' +
      '<h1>' + q.score + ' / ' + q.qs.length + ' 正确</h1></div>' +
      '<div class="head-stats"><span class="pill accent">正确率 <b>' + rate + '%</b></span></div></div>' +
      '<div class="done-card"><div class="done-mark">' + ICON.check + '</div>' +
      '<h2>' + (rate >= 80 ? '记得很稳' : rate >= 50 ? '还差一点火候' : '这几组需要再滚一遍') + '</h2>' +
      '<p>答错的词已经排进复习队列，明天会更早见到它们。</p>' +
      '<div class="done-actions" style="margin-top:18px">' +
      '<button class="btn primary" data-action="quiz-again">再来一组</button>' +
      '<button class="btn" data-action="quiz-mode">换个模式</button>' +
      '<button class="btn" data-action="quiz-close">回到今日</button></div></div>';
  }

  function renderQuiz(root) {
    var q = APP.quiz;
    if (!q) {
      var n = quizPool().length;
      root.innerHTML =
        '<div class="page-head"><div><p class="kicker">自测</p><h1>想练哪一项</h1></div>' +
        '<div class="head-stats"><span class="pill accent">可抽 <b>' + Math.min(10, n) + '</b> 词</span></div></div>' +
        '<div class="mode-grid">' +
          '<button class="mode-card" data-action="quiz-start" data-mode="choice">' +
            '<span class="mode-k">看词选义</span>' +
            '<span class="mode-d">给一个单词，四选一挑出正确释义。练「读得懂」。</span>' +
          '</button>' +
          '<button class="mode-card" data-action="quiz-start" data-mode="dictation">' +
            '<span class="mode-k">听音拼写</span>' +
            '<span class="mode-d">只放发音、不显示单词，把它完整拼出来。练「听得清、拼得对」。</span>' +
          '</button>' +
        '</div>' +
        '<p class="mode-tip">都从学过的词里随机抽 10 个；答错的词会提前回到复习队列。</p>';
      return;
    }

    if (q.finished) { root.innerHTML = quizResultHTML(q); return; }
    if (q.mode === 'dictation') { renderDictation(root, q); return; }

    var item = q.qs[q.i];
    var letters = ['A', 'B', 'C', 'D'];
    var opts = item.options.map(function (o, i) {
      var cls = 'option';
      if (q.picked !== null) {
        if (o === item.answer) cls += ' correct';
        else if (i === q.picked) cls += ' wrong';
      }
      return '<button class="' + cls + '" data-action="pick" data-i="' + i + '"' + (q.picked !== null ? ' disabled' : '') + '>' +
        '<span class="idx">' + letters[i] + '</span>' + esc(o) + '</button>';
    }).join('');

    root.innerHTML =
      '<div class="page-head"><div><p class="kicker">看词选义 · 第 ' + (q.i + 1) + ' / ' + q.qs.length + ' 题</p><h1>选出正确释义</h1></div>' +
      '<div class="head-stats"><span class="pill">答对 <b>' + q.score + '</b></span></div></div>' +
      '<div class="quiz-card">' +
        '<div class="quiz-word">' + esc(item.w.w) + '</div>' +
        '<div class="options">' + opts + '</div>' +
        '<div class="quiz-foot"><span class="quiz-score ' + (q.picked === null ? '' : (item.options[q.picked] === item.answer ? 'good' : 'bad')) + '">' +
          (q.picked === null ? '按 1–4 也可以选' : (item.options[q.picked] === item.answer ? '答对了' : '正确答案：' + item.answer)) +
        '</span>' +
        '<button class="btn primary small" data-action="quiz-next"' + (q.picked === null ? ' disabled' : '') + '>' +
          (q.i + 1 >= q.qs.length ? '看结果' : '下一题') + '</button></div>' +
      '</div>';
  }

  function renderDictation(root, q) {
    var item = q.qs[q.i];
    var w = item.w;
    var last = q.i + 1 >= q.qs.length;
    var fb = '';
    if (q.checked) {
      fb = '<div class="dict-feedback ' + (q.ok ? 'ok' : 'bad') + '">' +
        '<b>' + (q.ok ? '拼写正确' : '正确拼写：' + esc(w.w)) + '</b>' +
        '<span>' + esc(w.cn || '') + '</span></div>';
    }
    root.innerHTML =
      '<div class="page-head"><div><p class="kicker">听音拼写 · 第 ' + (q.i + 1) + ' / ' + q.qs.length + ' 题</p><h1>听发音，拼单词</h1></div>' +
      '<div class="head-stats"><span class="pill">拼对 <b>' + q.score + '</b></span></div></div>' +
      '<div class="quiz-card dict-card">' +
        '<button class="dict-speak" data-action="speak-quiz" aria-label="再听一遍">' + ICON.speaker + '</button>' +
        '<p class="dict-hint">' + (q.checked ? '答案已经揭晓' : '点喇叭可以再听，按 Enter 提交') + '</p>' +
        '<input id="dictInput" class="dict-input" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
          'value="' + esc(q.typed || '') + '"' + (q.checked ? ' disabled' : '') + ' placeholder="输入你听到的单词">' +
        fb +
        '<div class="quiz-foot">' +
          '<span class="quiz-score">' + (q.checked ? (q.ok ? '很好，继续保持' : '已记入复习队列') : '拼写不区分大小写') + '</span>' +
          '<button class="btn primary small" data-action="' + (q.checked ? 'dict-next' : 'dict-check') + '">' +
            (q.checked ? (last ? '看结果' : '下一题') : '检查') + '</button>' +
        '</div>' +
      '</div>';
  }

  function pickOption(i) {
    var q = APP.quiz;
    if (!q || q.mode !== 'choice' || q.picked !== null || q.finished) return;
    var item = q.qs[q.i];
    q.picked = i;
    q.answered += 1;
    var right = item.options[i] === item.answer;
    if (right) {
      q.score += 1;
    } else {
      markWrong(item.w);
    }
    render();
    if (right) {
      setTimeout(function () {
        if (APP.quiz === q && !q.finished && q.picked !== null) quizNext();
      }, 850);
    }
  }

  function markWrong(w) {
    var k = C.keyOf(w);
    var prev = APP.state.progress[k] || C.blankRec();
    APP.state.progress[k] = C.review(prev, 'again', APP.today);
    var d = dayRec();
    if (prev.last !== APP.today) { d.reviewDone += 1; APP.state.days[APP.today] = d; }
    save();
  }

  function dictCheck() {
    var q = APP.quiz;
    if (!q || q.mode !== 'dictation' || q.checked || q.finished) return;
    var input = document.getElementById('dictInput');
    var typed = input ? input.value : '';
    q.typed = typed;
    var norm = function (x) {
      return String(x).toLowerCase().replace(/[\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
    };
    var target = norm(q.qs[q.i].w.w);
    var got = norm(typed);
    q.checked = true;
    q.ok = got === target && got.length > 0;
    q.answered += 1;
    if (q.ok) q.score += 1; else markWrong(q.qs[q.i].w);
    render();
    if (q.ok) {
      setTimeout(function () {
        if (APP.quiz === q && !q.finished && q.checked) dictNext();
      }, 850);
    }
  }

  function dictNext() {
    var q = APP.quiz;
    if (!q || q.mode !== 'dictation' || !q.checked) return;
    if (q.i + 1 >= q.qs.length) { q.finished = true; render(); return; }
    q.i += 1;
    q.checked = false;
    q.ok = false;
    q.typed = '';
    render();
    setTimeout(speakQuizWord, 120);
  }

  function quizNext() {
    var q = APP.quiz;
    if (!q || q.finished) return;
    if (q.mode === 'dictation') { if (q.checked) dictNext(); return; }
    if (q.picked === null) return;
    if (q.i + 1 >= q.qs.length) { q.finished = true; render(); return; }
    q.i += 1;
    q.picked = null;
    render();
    if (settings().autoplay) setTimeout(speakQuizCurrent, 120);
  }

  /* ---------- 导入 ---------- */

  var SAMPLE = [
    'abandon 放弃；抛弃',
    'ability 能力；才能',
    'absorb 吸收；理解',
    'abstract 抽象的',
    'academic 学术的',
    'accept 接受',
    'access 通道；获取',
    'accident 事故',
    'account 账户；描述',
    'achieve 达到；实现'
  ].join('\n');

  function renderImport(root) {
    var meta = APP.deck.meta || {};
    var p = APP.preview;
    root.innerHTML =
      '<div class="page-head"><div><p class="kicker">词表</p><h1>导入自己的词表</h1></div>' +
      '<div class="head-stats"><span class="pill">当前 <b>' + totalCount() + '</b> 词</span></div></div>' +

      '<div class="panel">' +
        '<h3>粘贴词表</h3>' +
        '<p class="desc">一行一个词，支持「单词 空格 释义」「单词 Tab 释义」「单词,释义」「word /音标/ 释义」。' +
        '想自己指定分组，就在组前加一行 <code># 组名</code>；不加的话会按词根和场景自动归类，每 20 词一组。</p>' +
        '<textarea id="importText" spellcheck="false" placeholder="' + esc(SAMPLE) + '">' + esc(APP.importText || '') + '</textarea>' +
        '<div class="import-foot">' +
          '<label class="file-btn">选择文件（txt / csv）<input type="file" id="fileInput" accept=".txt,.csv,.tsv,text/plain"></label>' +
          '<span class="hint">进度按单词保存，导入新词表不会清空已学记录</span>' +
          '<button class="btn small" data-action="import-preview">预览分组</button>' +
          '<button class="btn primary small" data-action="import-save"' + (p ? '' : ' disabled') + '>替换词库并保存</button>' +
        '</div>' +
        (p ? '<div class="group-chips">' + p.groups.slice(0, 12).map(function (g) {
          return '<span>' + esc(g.title) + ' · ' + g.words.length + '</span>';
        }).join('') + (p.groups.length > 12 ? '<span>…共 ' + p.groups.length + ' 组</span>' : '') + '</div>' : '') +
      '</div>' +

      '<div class="panel">' +
        '<h3>当前词库</h3>' +
        '<p class="desc">' + esc(meta.name || '未命名') + ' · ' + (APP.deck.groups || []).length + ' 组 · ' + totalCount() + ' 词' +
        (meta.importedAt ? ' · 导入于 ' + esc(meta.importedAt.slice(0, 10)) : '') + '</p>' +
        '<div class="import-foot">' +
          (APP.state.backupDeck ? '<button class="btn small" data-action="restore-deck">恢复导入前的词库</button>' : '') +
          '<button class="btn small" data-action="export-deck">导出词库 JSON</button>' +
        '</div>' +
      '</div>';
  }

  function previewImport() {
    var text = APP.importText || '';
    if (!text) { var ta = $('importText'); text = ta ? ta.value : ''; }
    APP.importText = text;
    if (!text.trim()) { toast('先粘贴或选择一个词表文件'); return; }
    var res = C.parseWordList(text, settings().perDay || 20);
    if (!res.count) { toast('没识别到单词，检查一下每行是不是「单词 + 释义」'); return; }
    APP.preview = res;
    render();
    toast('识别到 ' + res.count + ' 个词，分成 ' + res.groups.length + ' 组');
  }

  function saveImport() {
    var p = APP.preview;
    if (!p || !p.count) { toast('先点“预览分组”'); return; }
    if (!APP.state.backupDeck) APP.state.backupDeck = APP.deck;
    APP.state.deck = {
      meta: {
        name: '我的词库',
        desc: '导入生成的词库',
        perGroup: settings().perDay || 20,
        version: 1,
        importedAt: new Date().toISOString(),
        builtin: false
      },
      groups: p.groups
    };
    APP.deck = APP.state.deck;
    buildIndex();
    APP.preview = null;
    APP.session = null;
    save();
    toast('已替换词库，共 ' + p.count + ' 词 / ' + p.groups.length + ' 组');
    APP.view = 'deck';
    render();
  }

  function exportDeck() {
    var blob = new Blob([JSON.stringify(APP.deck, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kaijici-deck.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ---------- 统计 ---------- */

  function renderStats(root) {
    var m = C.mastery(APP.deck, APP.state.progress);
    var learned = m.learning + m.mastered;
    var st = C.streak(APP.state.days, APP.today);
    var days = C.recentDays(APP.state.days, APP.today, 14);
    var max = Math.max.apply(null, days.map(function (d) { return d.count; }).concat([1]));

    var chart = days.map(function (d) {
      var h = d.count ? Math.max(6, Math.round((d.count / max) * 100)) : 3;
      return '<div class="col" title="' + d.key + ' · ' + d.count + ' 词">' +
        '<div class="fill' + (d.count ? ' has' : '') + '" style="height:' + h + '%"></div>' +
        '<div class="lbl">' + d.label + '</div></div>';
    }).join('');

    var pct = function (n) { return m.total ? Math.round((n / m.total) * 100) : 0; };
    var seg = function (action, v, cur) {
      return '<button data-action="' + action + '" data-v="' + v + '" class="' + (cur === v ? 'on' : '') + '">' + v + '</button>';
    };

    root.innerHTML =
      '<div class="page-head"><div><p class="kicker">学习记录</p><h1>这一路的数字</h1></div>' +
      '<div class="head-stats"><span class="pill">🔥 连续 <b>' + st + '</b> 天</span></div></div>' +

      '<div class="stats-grid">' +
        '<div class="stat-tile"><b>' + learned + '</b><span>已学单词</span></div>' +
        '<div class="stat-tile"><b>' + m.mastered + '</b><span>已掌握</span></div>' +
        '<div class="stat-tile"><b>' + dueWords().length + '</b><span>今天待复习</span></div>' +
        '<div class="stat-tile"><b>' + (m.total - learned) + '</b><span>还没见过</span></div>' +
      '</div>' +

      '<div class="panel"><h3>最近 14 天</h3>' +
      '<p class="desc">每天新学 + 复习的词数</p>' +
      '<div class="chart">' + chart + '</div></div>' +

      '<div class="panel"><h3>掌握程度</h3><p class="desc">掌握 = 复习间隔超过 21 天</p>' +
        '<div class="mastery-row"><span class="lbl">已掌握</span><span class="track"><i style="width:' + pct(m.mastered) + '%;background:var(--accent)"></i></span><span class="n">' + m.mastered + '</span></div>' +
        '<div class="mastery-row"><span class="lbl">学习中</span><span class="track"><i style="width:' + pct(m.learning) + '%;background:var(--amber)"></i></span><span class="n">' + m.learning + '</span></div>' +
        '<div class="mastery-row"><span class="lbl">未学习</span><span class="track"><i style="width:' + pct(m.new) + '%;background:var(--line-strong)"></i></span><span class="n">' + m.new + '</span></div>' +
      '</div>' +

      '<div class="panel"><h3>设置</h3>' +
        '<div class="settings-row"><div><div class="t">每天新词</div><div class="d">决定每天自动打开后的任务量</div></div>' +
          '<div class="seg">' + seg('set-perday', 10, settings().perDay) + seg('set-perday', 20, settings().perDay) + seg('set-perday', 30, settings().perDay) + '</div></div>' +
        '<div class="settings-row"><div><div class="t">每次复习上限</div><div class="d">到期的词太多时，一次最多过多少个</div></div>' +
          '<div class="seg">' + seg('set-limit', 20, settings().reviewLimit) + seg('set-limit', 40, settings().reviewLimit) + seg('set-limit', 60, settings().reviewLimit) + '</div></div>' +
        '<div class="settings-row"><div><div class="t">自动发音</div><div class="d">换到新词时自动读一遍</div></div>' +
          '<div class="seg">' + '<button data-action="set-autoplay" data-v="0" class="' + (!settings().autoplay ? 'on' : '') + '">关</button>' +
          '<button data-action="set-autoplay" data-v="1" class="' + (settings().autoplay ? 'on' : '') + '">开</button></div></div>' +
        '<div class="settings-row"><div><div class="t">认识后拼写</div><div class="d">点「认识」后要手打一遍，错了标红对比</div></div>' +
          '<div class="seg">' + '<button data-action="set-spell" data-v="0" class="' + (!settings().spell ? 'on' : '') + '">关</button>' +
          '<button data-action="set-spell" data-v="1" class="' + (settings().spell ? 'on' : '') + '">开</button></div></div>' +
        '<div class="settings-row"><div><div class="t">听音模式</div><div class="d">先听发音、自己回忆拼写，按空格再看词</div></div>' +
          '<div class="seg">' + '<button data-action="set-listen" data-v="0" class="' + (!settings().listen ? 'on' : '') + '">关</button>' +
          '<button data-action="set-listen" data-v="1" class="' + (settings().listen ? 'on' : '') + '">开</button></div></div>' +
        '<div class="settings-row"><div><div class="t">清空学习进度</div><div class="d">词库保留，只重置记忆曲线</div></div>' +
          '<button class="btn small" data-action="reset-progress">重置</button></div>' +
      '</div>' +

      '<p style="color:var(--muted);font-size:11.5px;text-align:center;margin:26px 0 0">' +
        '开机词 · 数据只存在这台电脑上 · ' + esc(APP.state.createdAt ? APP.state.createdAt.slice(0, 10) : '') + ' 开始记录</p>';
  }

  /* ================= 事件 ================= */

  function buildIndex() {
    APP.index = {};
    (APP.deck.groups || []).forEach(function (g, gi) {
      (g.words || []).forEach(function (w) { APP.index[C.keyOf(w)] = gi; });
    });
  }

  function bind() {
    $('nav').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-view]');
      if (!btn) return;
      navigate(btn.getAttribute('data-view'));
    });

    $('app').addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var action = el.getAttribute('data-action');
      if (action === 'reveal') {
        APP.revealed = true;
        render();
      } else if (action === 'grade') {
        grade(el.getAttribute('data-grade'));
      } else if (action === 'speak') {
        speakCurrent();
      } else if (action === 'speak-word') {
        speak(el.getAttribute('data-w') || '');
      } else if (action === 'extra') {
        extraGroup();
      } else if (action === 'start-review') {
        startReview();
      } else if (action === 'start-weak') {
        startWeak();
      } else if (action === 'review-back') {
        APP.session = null;
        render();
      } else if (action === 'add-notebook') {
        var nbName = addNotebook(el.getAttribute('data-w'), el.getAttribute('data-cn'), '', 'card');
        if (nbName) {
          toast('已加入「' + nbName + '」');
          render();
        }
      } else if (action === 'nb-create') {
        var nameEl = document.getElementById('nbName');
        var name = nameEl ? nameEl.value.trim() : '';
        if (!name) { toast('先起个名字'); }
        else {
          var book = { id: nbNewId(), name: name, words: [], created: APP.today };
          APP.state.notebooks.push(book);
          APP.nbId = book.id;
          APP.view = 'notebook-detail';
          save(); render();
          toast('已新建「' + name + '」');
        }
      } else if (action === 'nb-open') {
        APP.nbId = el.getAttribute('data-id');
        APP.session = null;
        APP.spell = null;
        APP.nbRenaming = false;
        APP.view = 'notebook-detail';
        render();
      } else if (action === 'nb-list') {
        APP.view = 'notebook'; APP.session = null; APP.spell = null; APP.nbRenaming = false; render();
      } else if (action === 'nb-rename') {
        APP.nbRenaming = true; render();
        var ri = document.getElementById('nbRename'); if (ri) { ri.focus(); ri.select(); }
      } else if (action === 'nb-rename-cancel') {
        APP.nbRenaming = false; render();
      } else if (action === 'nb-rename-save') {
        var nb0 = nbFind(APP.nbId);
        var rn = document.getElementById('nbRename');
        var newName = rn ? rn.value.trim() : '';
        if (nb0 && newName) {
          nb0.name = newName;
          if (APP.session && APP.session.nbId === nb0.id) APP.session.nbName = newName;
          save();
        }
        APP.nbRenaming = false; render();
      } else if (action === 'nb-delete') {
        var del = nbFind(APP.nbId);
        if (!del) return;
        if (confirm('删除「' + del.name + '」和里面的 ' + del.words.length + ' 个词？')) {
          APP.state.notebooks = APP.state.notebooks.filter(function (x) { return x.id !== del.id; });
          APP.session = null;
          APP.view = 'notebook';
          save(); render();
          toast('已删除「' + del.name + '」');
        }
      } else if (action === 'nb-add') {
        submitNotebookWord();
      } else if (action === 'nb-del') {
        var nb1 = nbFind(APP.nbId);
        var idx = parseInt(el.getAttribute('data-i'), 10);
        if (nb1 && nb1.words[idx]) {
          var gone = nb1.words[idx];
          nb1.words.splice(idx, 1);
          save(); render();
          toast('已删除 ' + gone.w);
        }
      } else if (action === 'nb-speak') {
        speak(el.getAttribute('data-w') || '');
      } else if (action === 'nb-enrich') {
        enrichNotebook();
      } else if (action === 'nb-study') {
        startNotebookStudy(el.getAttribute('data-id'));
      } else if (action === 'nb-back') {
        APP.session = null;
        APP.spell = null;
        APP.revealed = false;
        render();
      } else if (action === 'quiz-start') {
        startQuiz(el.getAttribute('data-mode') || 'choice');
      } else if (action === 'quiz-again') {
        startQuiz(APP.quiz && APP.quiz.mode);
      } else if (action === 'quiz-mode') {
        APP.quiz = null;
        render();
      } else if (action === 'pick') {
        pickOption(parseInt(el.getAttribute('data-i'), 10));
      } else if (action === 'quiz-next') {
        quizNext();
      } else if (action === 'spell-check') {
        checkSpell();
      } else if (action === 'spell-next') {
        advanceAfterSpell();
      } else if (action === 'dict-check') {
        dictCheck();
      } else if (action === 'dict-next') {
        dictNext();
      } else if (action === 'speak-quiz') {
        speakQuizWord();
      } else if (action === 'quiz-close') {
        APP.quiz = null;
        navigate('today');
      } else if (action === 'go-deck') {
        navigate('deck');
      } else if (action === 'open-group') {
        APP.groupId = parseInt(el.getAttribute('data-id'), 10);
        APP.view = 'group';
        render();
        window.scrollTo(0, 0);
      } else if (action === 'back-deck') {
        APP.view = 'deck';
        render();
      } else if (action === 'import-preview') {
        previewImport();
      } else if (action === 'import-save') {
        saveImport();
      } else if (action === 'export-deck') {
        exportDeck();
      } else if (action === 'restore-deck') {
        if (APP.state.backupDeck) {
          APP.state.deck = APP.state.backupDeck;
          APP.state.backupDeck = null;
          APP.deck = APP.state.deck;
          buildIndex();
          APP.session = null;
          save();
          toast('已恢复');
          render();
        }
      } else if (action === 'set-perday') {
        settings().perDay = parseInt(el.getAttribute('data-v'), 10);
        APP.session = null;
        save(); render();
      } else if (action === 'set-limit') {
        settings().reviewLimit = parseInt(el.getAttribute('data-v'), 10);
        save(); render();
      } else if (action === 'set-autoplay') {
        settings().autoplay = el.getAttribute('data-v') === '1';
        save(); render();
      } else if (action === 'set-spell') {
        settings().spell = el.getAttribute('data-v') === '1';
        save(); render();
      } else if (action === 'set-listen') {
        settings().listen = el.getAttribute('data-v') === '1';
        APP.spokenTag = null;
        save(); render();
      } else if (action === 'reset-progress') {
        if (confirm('确定清空全部学习进度吗？词库会保留。')) {
          APP.state.progress = {};
          APP.state.days = {};
          APP.session = null;
          save();
          toast('进度已清空');
          render();
        }
      }
    });

    $('app').addEventListener('keydown', function (e) {
      if (e.target.id === 'dictInput' && e.key === 'Enter') {
        e.preventDefault();
        dictCheck();
      }
      if ((e.target.id === 'nbWord' || e.target.id === 'nbCn') && e.key === 'Enter') {
        e.preventDefault();
        var addBtn = document.querySelector('[data-action="nb-add"]');
        if (addBtn) addBtn.click();
      }
      if (e.target.id === 'nbName' && e.key === 'Enter') {
        e.preventDefault();
        var cBtn = document.querySelector('[data-action="nb-create"]');
        if (cBtn) cBtn.click();
      }
      if (e.target.id === 'nbRename' && e.key === 'Enter') {
        e.preventDefault();
        var sBtn = document.querySelector('[data-action="nb-rename-save"]');
        if (sBtn) sBtn.click();
      }
      if (e.target.id === 'spellInput' && e.key === 'Enter') {
        e.preventDefault();
        checkSpell();
      }
    });

    $('app').addEventListener('input', function (e) {
      if (e.target.id === 'importText') APP.importText = e.target.value;
    });

    $('app').addEventListener('change', function (e) {
      if (e.target.id === 'fileInput') {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          APP.importText = String(reader.result || '');
          var ta = $('importText');
          if (ta) ta.value = APP.importText;
          toast('已读取 ' + f.name + '，点“预览分组”看看');
        };
        reader.readAsText(f, 'utf-8');
      }
    });

    $('themeBtn').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(LS_THEME, next); } catch (err) {}
    });

    document.addEventListener('keydown', function (e) {
      var q = APP.quiz;
      if (APP.view === 'quiz' && q && q.mode === 'dictation' && q.checked && !q.finished &&
          (e.key === 'Enter' || e.code === 'Space')) {
        e.preventDefault();
        dictNext();
        return;
      }
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

      // 拼写环节：检查完之后按回车/空格继续
      if (APP.spell) {
        if (APP.spell.checked && (e.key === 'Enter' || e.code === 'Space')) {
          e.preventDefault();
          advanceAfterSpell();
        }
        return;
      }

      var study = APP.view === 'today' || APP.view === 'review' ||
                  APP.view === 'notebook' || APP.view === 'notebook-detail';
      if (study && APP.session && APP.session.pos < APP.session.queue.length) {
        if (e.code === 'Space' || e.key === 'Enter') {
          e.preventDefault();
          if (!APP.revealed) { APP.revealed = true; render(); }
          return;
        }
        if (APP.revealed && ['1', '2', '3'].indexOf(e.key) !== -1) {
          e.preventDefault();
          grade(['again', 'hard', 'good'][parseInt(e.key, 10) - 1]);
          return;
        }
      }
      if (APP.view === 'quiz' && APP.quiz && !APP.quiz.finished) {
        if (/^[1-4]$/.test(e.key)) { e.preventDefault(); pickOption(parseInt(e.key, 10) - 1); }
        if (e.key === 'Enter') { e.preventDefault(); quizNext(); }
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        var t = C.todayKey();
        if (t !== APP.today) {
          APP.today = t;
          APP.session = null;
          APP.quiz = null;
          render();
        }
      }
    });

    window.addEventListener('beforeunload', function () {
      if (!APP.online) return;
      try {
        var blob = new Blob([JSON.stringify(APP.state)], { type: 'application/json' });
        navigator.sendBeacon('api/state', blob);
      } catch (err) {}
    });
  }

  function navigate(view) {
    if (view === APP.view && view !== 'group') { window.scrollTo(0, 0); return; }
    APP.view = view;
    APP.revealed = false;
    APP.quiz = view === 'quiz' ? APP.quiz : null;
    if (view !== 'today' && view !== 'review' && view !== 'notebook') APP.session = null;
    if (view === 'today') APP.session = null;
    if (view === 'review') APP.session = null;
    window.scrollTo(0, 0);
    render();
  }

  function applyTheme() {
    var saved = null;
    try { saved = localStorage.getItem(LS_THEME); } catch (e) {}
    if (!saved) saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', saved);
  }

  /* ================= 单窗口心跳 ================= */

  function startHeartbeat() {
    var wid = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    function ping() {
      fetch('api/ping?id=' + encodeURIComponent(wid), { cache: 'no-store' }).catch(function () {});
    }
    setTimeout(ping, 700);
    setInterval(ping, 4000);
  }

  /* ================= 启动 ================= */

  function boot() {
    applyTheme();
    $('app').innerHTML = '<div class="loader"><div class="dot"></div><span>正在打开今天的词…</span></div>';

    loadState().then(function (s) {
      APP.state = normalize(s || defaultState());
      return ensureDeck();
    }).then(function () {
      APP.deck = APP.state.deck;
      buildIndex();
      APP.families = C.buildFamilies(C.allWords(APP.deck).map(function (x) { return x.w; }));
      APP.byWord = {};
      C.allWords(APP.deck).forEach(function (x) { APP.byWord[String(x.w.w).toLowerCase()] = x.w; });
      bind();
      render();
      save();
      startHeartbeat();
    }).catch(function (err) {
      $('app').innerHTML =
        '<div class="done-card"><h2>没能打开词库</h2>' +
        '<p style="max-width:420px">本地服务似乎没有启动。请双击项目里的 <b>start.command</b>，然后再刷新这一页。</p>' +
        '<p style="font-size:11.5px;color:var(--muted)">' + esc(err && err.message || '') + '</p></div>';
    });
  }

  boot();
})();
