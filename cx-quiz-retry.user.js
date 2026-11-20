// ==UserScript==
// @name         超星 · 章节测验自动刷到满分（题库优先 + 蒙题兜底）
// @namespace    https://local.fix/cx-quiz-retry
// @version      1.6.0
// @description  第一轮交给题库（OCS）作答；交卷后从成绩页读出正确答案，点“重做”按正确答案重填，循环到满分。成绩页不给答案时自动改成“蒙”另一个选项。另带看门狗：题目都选完但超过 60 秒没提交时自动点提交。成绩页判定放宽、重做失败不消耗次数、没有 redoTest 时改用“重做/再次作答”链接。
// @author       local
// @match        *://*.chaoxing.com/*
// @match        *://*.xueyinonline.com/*
// @match        *://*.edu.cn/*
// @match        *://*.org.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.__cxq_running) return;
  window.__cxq_running = true;

  // ======== 可调参数 ========
  const MAX_ROUNDS = 6;
  const GUESS = true;
  const AUTO_FIRST = false;   // true = 没人交卷时脚本自己先蒙一轮
  const SUBMIT_DELAY = 1500;
  const STUCK_SUBMIT_AFTER = 60000;  // 题都选完了、超过这么久没提交 → 自动点提交
  const STUCK_GUESS_AFTER = 90000;   // 一直没人答题（题库没答案）超过这么久 → 自动蒙一轮再交
  const GUESS_WHEN_IDLE = true;      // 允许看门狗在“没人答”时开蒙
  const DEBUG = true;
  // ========================

  const K_CACHE = 'cxq_cache_v1';   // qid -> 正确答案
  const K_STATE = 'cxq_state_v2';   // quizKey -> {rounds, pending, stage, done}

  const log = (...a) => { if (DEBUG) console.log('%c[自动刷分]', 'color:#e11d48;font-weight:bold', ...a); };
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (n) => Math.floor(Math.random() * n);

  function badge(text, color) {
    try {
      const host = document.body || document.documentElement;
      let el = document.getElementById('cxq-badge');
      if (!el) {
        el = document.createElement('div');
        el.id = 'cxq-badge';
        el.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483647;padding:6px 10px;border-radius:8px;color:#fff;font:12px/1.5 system-ui;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;max-width:340px';
        host.appendChild(el);
      }
      el.style.background = color || 'rgba(225,29,72,.9)';
      el.textContent = '[自动刷分] ' + text;
    } catch (e) {}
  }

  // ---------- 这套题的唯一 key（同一份测验跨页面共享状态） ----------
  const VERSION = '1.6.0';
  try {
    if (localStorage.getItem('cxq_ver') !== VERSION) {
      localStorage.removeItem('cxq_state_v2');   // 换版本清掉旧的“轮数/状态”，避免被历史记录卡住
      localStorage.setItem('cxq_ver', VERSION);
    }
  } catch (e) {}

  function quizKey(doc) {
    try {
      const u = new URL(location.href);
      const w = u.searchParams.get('workId') || u.searchParams.get('workid');
      if (w) return 'w' + w;
    } catch (e) {}
    const li = doc.querySelector('.TiMu li[qid]');
    if (li) return 'q' + li.getAttribute('qid');
    return 'unknown';
  }
  function getSt(key) {
    const all = load(K_STATE, {});
    return all[key] || { rounds: 0, pending: {}, stage: '', done: false };
  }
  function setSt(key, st) {
    const all = load(K_STATE, {});
    all[key] = st;
    save(K_STATE, all);
  }

  // ---------- 跨 frame 弹窗 ----------
  function allDocs() {
    const docs = [], seen = new Set();
    const walk = (win, depth) => {
      if (depth > 5) return;
      let doc; try { doc = win.document; } catch (e) { return; }
      if (!doc || seen.has(doc)) return;
      seen.add(doc); docs.push(doc);
      let subs = []; try { subs = Array.from(win.frames); } catch (e) {}
      subs.forEach((w) => walk(w, depth + 1));
    };
    try { walk(window.top, 0); } catch (e) { walk(window, 0); }
    return docs;
  }
  function clickInAny(selector, textRe) {
    for (const d of allDocs()) {
      let els = [];
      try { els = Array.from(d.querySelectorAll(selector)); } catch (e) { continue; }
      for (const el of els) {
        if (!(el.offsetWidth || el.offsetHeight)) continue;
        if (textRe && !(el.textContent || '').trim().match(textRe)) continue;
        try { el.click(); return true; } catch (e) {}
      }
    }
    return false;
  }
  async function confirmDialog(timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (clickInAny('#popok')) return true;
      if (clickInAny('.popBottom .jb_btn', /^(提交|确定|交卷)$/)) return true;
      if (clickInAny('.layui-layer-btn0')) return true;
      await sleep(300);
    }
    return false;
  }

  // ---------- 成绩页 ----------
  function parseResult(doc) {
    const head = doc.querySelector('.ceyan_name');
    const m = (head ? head.textContent : '').match(/满分[:：]\s*([\d.]+)/);
    const full = m ? parseFloat(m[1]) : 100;
    const items = Array.from(doc.querySelectorAll('.TiMu')).map((el) => {
      const qid = String(el.getAttribute('data') || (el.id || '').replace('question', '')).trim();
      const correct = ((el.querySelector('.correctAnswer .answerCon') || {}).textContent || '').replace(/\s+/g, '').toUpperCase();
      const mine = ((el.querySelector('.myAnswer .answerCon') || {}).textContent || '').replace(/\s+/g, '').toUpperCase();
      const s = el.querySelector('.scoreNum');
      const score = s ? parseFloat(s.textContent) || 0 : 0;
      return { qid, correct, mine, score };
    }).filter((i) => i.qid);
    return { full, items, total: items.reduce((s, i) => s + i.score, 0) };
  }

  // ---------- 答题页 ----------
  function qidOf(el) {
    const li = el.querySelector('li[qid]');
    if (li) return li.getAttribute('qid');
    const inp = el.querySelector('input[id^="answer"]');
    return inp ? inp.id.replace('answer', '') : null;
  }
  function optionsOf(el) {
    return Array.from(el.querySelectorAll('span.num_option')).map((s) => s.getAttribute('data')).filter(Boolean);
  }
  function applyAnswers(doc, targets) {
    let changed = 0;
    Array.from(doc.querySelectorAll('.TiMu')).forEach((el) => {
      const qid = qidOf(el);
      if (!qid) return;
      const target = (targets[qid] || '').toUpperCase();
      if (!target) return;
      const input = doc.querySelector('#answer' + qid);
      const current = (input && input.value ? input.value : '').toUpperCase();
      current.split('').forEach((L) => {
        if (target.indexOf(L) === -1) {
          const sp = el.querySelector('span.num_option[data="' + L + '"]');
          const li = sp && sp.closest('li');
          if (li) { li.click(); changed++; }
        }
      });
      target.split('').forEach((L) => {
        const sp = el.querySelector('span.num_option[data="' + L + '"]');
        const li = sp && sp.closest('li');
        if (!li) return;
        const now = doc.querySelector('#answer' + qid);
        const val = (now && now.value ? now.value : '').toUpperCase();
        if (val.indexOf(L) === -1) { li.click(); changed++; }
      });
    });
    return changed;
  }
  function guessTargets(doc, prev) {
    const t = {};
    Array.from(doc.querySelectorAll('.TiMu')).forEach((el) => {
      const qid = qidOf(el);
      if (!qid) return;
      const opts = optionsOf(el);
      if (!opts.length) return;
      const typeEl = doc.querySelector('#answertype' + qid);
      const qtype = typeEl ? typeEl.value : '0';
      const n = qtype === '1' ? Math.min(2 + rnd(2), opts.length) : 1;
      const pool = opts.filter((L) => (prev[qid] || '').indexOf(L) === -1);
      const from = pool.length >= n ? pool : opts;
      const pick = [];
      while (pick.length < n && pick.length < from.length) {
        const L = from[rnd(from.length)];
        if (pick.indexOf(L) === -1) pick.push(L);
      }
      t[qid] = pick.sort().join('');
    });
    return t;
  }
  async function submitWork(doc) {
    const btn = doc.querySelector('a.btnSubmit');
    if (!btn) return false;
    btn.click();
    const ok = await confirmDialog();
    log('提交', ok ? '成功' : '没点动确认框');
    return ok;
  }

  // ---------- 看门狗：题都选完却迟迟不提交 ----------
  async function stuckSubmit(doc, key) {
    if (!STUCK_SUBMIT_AFTER) return false;
    const btn = doc.querySelector('a.btnSubmit');
    if (!btn) return false;
    const items = Array.from(doc.querySelectorAll('.TiMu'));
    if (!items.length) return false;
    const answers = items.map((el) => {
      const qid = qidOf(el);
      const inp = qid ? doc.querySelector('#answer' + qid) : null;
      return (inp && inp.value ? inp.value : '').trim();
    });
    const answered = answers.filter(Boolean).length;
    const sig = answered + '/' + items.length + '|' + answers.join(',');
    const k = 'cxq_watch2_' + key;
    const prev = load(k, null);
    if (!prev || prev.sig !== sig) {
      save(k, { sig, at: Date.now(), tries: 0 });
      return false;
    }
    const idle = Date.now() - prev.at;

    // 情况 A：题都选完了，但迟迟不交 → 替你点提交
    if (answered >= items.length) {
      if (idle < STUCK_SUBMIT_AFTER) return false;
      log('看门狗：题都选完了但' + Math.round(idle / 1000) + '秒没提交，替你点提交');
      badge('题目已选完但一直没交卷，自动点提交（第 ' + ((prev.tries || 0) + 1) + ' 次）', 'rgba(217,119,6,.95)');
      save(k, { sig, at: Date.now(), tries: (prev.tries || 0) + 1 });
      btn.click();
      await confirmDialog();
      return true;
    }

    // 情况 B：根本没人答（题库没答案/OCS 卡住），干等太久 → 开蒙
    if (!GUESS_WHEN_IDLE) return false;
    if (idle < STUCK_GUESS_AFTER) return false;
    const targets = guessTargets(doc, {});
    const n = applyAnswers(doc, targets);
    log('看门狗：' + Math.round(idle / 1000) + '秒没人答题，蒙了 ' + n + ' 个选项，准备提交');
    badge('题库没答案/没人作答，帮你蒙了一轮（' + n + ' 项），3 秒后提交', 'rgba(217,119,6,.95)');
    save(k, { sig: sig + '|guess', at: Date.now(), tries: (prev.tries || 0) + 1 });
    await sleep(1500);
    btn.click();
    await confirmDialog();
    return true;
  }

  // ---------- 主循环 ----------
  let busy = false;
  let lastBadge = '';

  async function tick() {
    if (busy) return;
    const doc = document;
    const timuCount = doc.querySelectorAll('.TiMu').length;
    // 成绩页判定放宽：只要是“有成绩/正确答案、且提交按钮不可见”
    const visibleSubmit = Array.from(doc.querySelectorAll('a.btnSubmit')).some((b) => b.offsetWidth || b.offsetHeight);
    const hasScore = !!doc.querySelector('.scoreNum, .correctAnswer, .ceyan_name .achievement');
    const isResult = !!doc.querySelector('.ceyan_name') && hasScore && !visibleSubmit && timuCount > 0;
    const key = quizKey(doc);
    let st = getSt(key);

    if (st.done) { badge('这套已满分，收工', 'rgba(22,163,74,.95)'); return; }

    // ===== 成绩页 =====
    if (isResult) {
      busy = true;
      try {
        const res = parseResult(doc);
        const cache = load(K_CACHE, {});
        let learned = 0;
        res.items.forEach((i) => { if (/^[A-Z]+$/.test(i.correct)) { cache[i.qid] = i.correct; learned++; } });
        save(K_CACHE, cache);
        log('成绩页', res.total, '/', res.full, '题数', res.items.length, '学到', learned, 'key', key);

        if (res.total >= res.full - 0.1) {
          badge('满分 ' + res.total + '/' + res.full + '，收工', 'rgba(22,163,74,.95)');
          setSt(key, { rounds: st.rounds, pending: {}, stage: '', done: true });
          return;
        }
        if (st.rounds >= MAX_ROUNDS) {
          badge('已交 ' + st.rounds + ' 次仍未满分，停下（可能限次）', 'rgba(220,38,38,.95)');
          return;
        }
        if (typeof window.redoTest !== 'function') {
          // 有些页面不给函数，只给一个“重做 / 再次作答”链接
          const link = Array.from(doc.querySelectorAll('a,button,span,div'))
            .find((el) => (el.offsetWidth || el.offsetHeight) && /^(重做|再次作答|再做一次|重新作答)$/.test((el.textContent || '').trim()));
          if (link) {
            log('用链接重做：', link.textContent.trim());
            link.click();
            const ok2 = await confirmDialog();
            setSt(key, { rounds: ok2 ? st.rounds + 1 : st.rounds, pending: {}, stage: '', done: false });
            return;
          }
          badge('本页没有“重做”入口（可能只允许 1 次），无法再试', 'rgba(220,38,38,.95)');
          return;
        }

        const targets = {};
        const prevMine = {};
        let guessed = 0;
        res.items.forEach((i) => {
          prevMine[i.qid] = i.mine || '';
          if (/^[A-Z]+$/.test(i.correct)) targets[i.qid] = i.correct;
          else if (GUESS) guessed++;
        });
        if (guessed) {
          const g = guessTargets(doc, prevMine);
          Object.keys(g).forEach((k) => { if (!targets[k]) targets[k] = g[k]; });
        }
        badge('得分 ' + res.total + '/' + res.full + (guessed ? '，蒙 ' + guessed + ' 题' : '，按正确答案') + '，第 ' + (st.rounds + 1) + ' 次重做…', 'rgba(217,119,6,.95)');
        window.redoTest();
        const ok = await confirmDialog();
        // 只有确认成功才消耗轮数，避免“点了没反应”把次数耗光
        setSt(key, { rounds: ok ? st.rounds + 1 : st.rounds, pending: targets, stage: ok ? 'redo' : '', done: false });
        if (!ok) badge('重做没点动（弹窗没出现/被拦），下一轮再试，不消耗次数', 'rgba(217,119,6,.95)');
        log('redoTest', ok ? 'ok' : 'fail');
      } finally {
        busy = false;
      }
      return;
    }

    // ===== 答题页 =====
    if (timuCount > 0) {
      // 看门狗：题库没答案时 OCS 会卡在“等待提交”，这里兜底点掉
      if (st.stage !== 'redo' && await stuckSubmit(doc, key)) return;
      // 1) 由脚本发起的重做：填目标答案并交卷
      if (st.stage === 'redo' && Object.keys(st.pending || {}).length) {
        busy = true;
        try {
          badge('重做中：按目标答案填涂…');
          const n = applyAnswers(doc, st.pending);
          log('改动', n, '个选项，key', key);
          await sleep(SUBMIT_DELAY);
          const ok = await submitWork(doc);
          setSt(key, { rounds: st.rounds, pending: ok ? {} : st.pending, stage: ok ? '' : 'redo', done: false });
          badge(ok ? '已交卷，等成绩…' : '交卷没成功，下一轮重试', ok ? undefined : 'rgba(220,38,38,.95)');
        } finally {
          busy = false;
        }
        return;
      }

      // 2) 有历史答案就用它填（不自动交卷）
      const cache = load(K_CACHE, {});
      const hits = Array.from(doc.querySelectorAll('.TiMu')).filter((el) => cache[qidOf(el)]);
      if (hits.length) {
        const n = applyAnswers(doc, cache);
        if (n) log('按历史答案填了', n, '个选项');
        const msg = '已按记住的答案填了 ' + hits.length + ' 题，等题库/交卷';
        if (msg !== lastBadge) { badge(msg); lastBadge = msg; }
        return;
      }

      // 3) 没人交卷时，脚本自己先蒙一轮
      if (AUTO_FIRST && st.rounds === 0 && st.stage !== 'auto-done') {
        busy = true;
        try {
          badge('没有题库，先蒙一轮交上去换答案…');
          const g = guessTargets(doc, {});
          applyAnswers(doc, g);
          await sleep(SUBMIT_DELAY);
          const ok = await submitWork(doc);
          setSt(key, { rounds: ok ? 1 : 0, pending: {}, stage: ok ? 'auto-done' : '', done: false });
          log('第一次蒙完交卷', ok ? '成功' : '失败');
        } finally {
          busy = false;
        }
        return;
      }
    }
  }

  badge('已启动（题库优先，答错自动重做）');
  setInterval(() => { tick().catch((e) => log('出错', e)); }, 1600);
  tick().catch(() => {});
})();




