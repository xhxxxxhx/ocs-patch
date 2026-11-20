// ==UserScript==
// @name         学习通 · 自动下一章（兜底修复）
// @namespace    https://local.fix/cx-auto-next
// @version      1.1.0
// @description  任务点完成后自动跳下一章，跳转落空会重试；连续 10 分钟没有推进时按级自救：视频暂停就点播放 → 切到学习测验 → 强制点下一节 → 整页刷新让 OCS 重新接管 → 仍不动才红条告警。
// @author       local
// @match        *://*.chaoxing.com/*
// @match        *://*.xueyinonline.com/*
// @match        *://*.edu.cn/*
// @match        *://*.org.cn/*
// @match        *://*.hnsyu.net/*
// @match        *://*.qutjxjy.cn/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[自动下一章]';
  const log = (...a) => console.log('%c' + TAG, 'color:#2563eb;font-weight:bold', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 只在顶层页面跑，避免 iframe 里重复执行、点两次
  try { if (window.top !== window) return; } catch (e) { return; }

  // ======== 可调参数 ========
  const WAIT_BEFORE_JUMP = 8000;      // 任务点完成后先等 OCS 自己跳多久
  const RETRY_GAP = 7000;             // 每次跳转尝试的间隔
  const MAX_TRIES = 10;               // 单次跳转最多试几次
  const STALL_MS = 10 * 60 * 1000;    // 10 分钟没有任何推进 → 升级处置
  const ESCALATE_GAP = 3 * 60 * 1000; // 升级动作之间隔 3 分钟，别乱点
  // ========================

  function topDoc() {
    try { if (top.document) return top.document; } catch (e) {}
    return document;
  }
  function topWin() { try { return top; } catch (e) { return window; } }
  function isStudyPage() { return /knowledge\/cards|mycourse\/studentstudy|nodedetailcontroller/.test(location.href); }

  const state = {
    chapterId: null,
    idleSince: Date.now(),
    lastAlive: Date.now(),     // 最后一次“有推进”的时间（换章 / 视频在放 / 题目在做）
    attempts: 0,
    lastActionAt: 0,
    lastEscalateAt: 0,
    escalateCount: 0,
    done: false
  };

  function notice(text, color) {
    try {
      let el = document.getElementById('cx-auto-next-tip');
      if (!el) {
        el = document.createElement('div');
        el.id = 'cx-auto-next-tip';
        el.style.cssText = [
          'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483647',
          'padding:6px 10px', 'border-radius:8px', 'font:12px/1.5 system-ui,sans-serif',
          'color:#fff', 'background:rgba(37,99,235,.9)', 'box-shadow:0 2px 8px rgba(0,0,0,.25)',
          'pointer-events:none', 'max-width:340px', 'white-space:normal'
        ].join(';');
        (document.body || document.documentElement).appendChild(el);
      }
      el.style.background = color || 'rgba(37,99,235,.9)';
      el.textContent = TAG + ' ' + text;
    } catch (e) {}
  }

  function getVal(d, sel) {
    const el = d.querySelector(sel);
    return el && 'value' in el ? el.value : el ? el.textContent : null;
  }

  function readChapter(d) {
    const active = d.querySelector('.posCatalog_active');
    let unfinishedEl = null;
    if (active) {
      unfinishedEl = active.querySelector('.jobUnfinishCount')
        || (active.parentElement && active.parentElement.querySelector('.jobUnfinishCount'))
        || null;
    }
    const unfinished = unfinishedEl ? parseInt(unfinishedEl.value || '0', 10) : null;
    const completedIcon = !!(active && active.querySelector('.icon_Completed'));
    const chapterId = getVal(d, '#curChapterId') || (active ? active.id : null);
    return {
      active,
      name: active ? (active.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '',
      chapterId,
      unfinished,
      completed: completedIcon || unfinished === 0,
      courseId: getVal(d, '#curCourseId'),
      clazzId: getVal(d, '#curClazzId'),
      tabCount: d.querySelectorAll('#prev_tab .prev_ul li').length
    };
  }

  function hasRunningJob(d) {
    try {
      const v = d.querySelector('video, #video_html5_api, #video');
      if (v && !v.paused && !v.ended && v.readyState > 2) return true;
    } catch (e) {}
    const quiz = Array.from(d.querySelectorAll('.TiMu')).some((el) => el.offsetParent !== null);
    if (quiz) return true;
    return false;
  }

  // 可见元素按文字找
  function findClickable(d, re, maxLen = 8) {
    const list = Array.from(d.querySelectorAll('a,button,div,span,li'));
    for (const el of list) {
      if (!(el.offsetWidth || el.offsetHeight)) continue;
      const t = (el.textContent || '').replace(/\s+/g, '');
      if (t.length <= maxLen && re.test(t)) return el;
    }
    return null;
  }

  function findNextButton(d) {
    const re = /^(进入下一[章节]|下一[章节]|继续学习|继续观看|确定|好的)$/;
    const containers = Array.from(
      d.querySelectorAll('.maskDiv,.layui-layer,.aui_state_focus,.popup,.dialog,[class*="modal"],[class*="dialog"],[class*="layer"]')
    ).filter((el) => el.offsetParent !== null);
    for (const c of containers) {
      const btn = Array.from(c.querySelectorAll('a,button,div,span,input[type="button"]'))
        .filter((el) => el.offsetParent !== null && re.test((el.textContent || el.value || '').trim()))
        .pop();
      if (btn) return { el: btn, where: 'dialog' };
    }
    const right = d.querySelector('#right.next, .prev_next.next, #next_tab, .next_tab');
    if (right && right.offsetParent !== null) return { el: right, where: 'footer' };
    const byText = findClickable(d, /^下一[章节]$/, 6);
    if (byText) return { el: byText, where: 'text' };
    return null;
  }

  function catalogItems(d) { return Array.from(d.querySelectorAll('[onclick^="getTeacherAjax"]')); }

  function clickNextChapter(d, info) {
    const btn = findNextButton(d);
    if (btn) {
      log('点击' + (btn.where === 'dialog' ? '弹窗' : '底部') + '按钮：', (btn.el.textContent || '').trim());
      btn.el.click();
      return 'button';
    }
    try {
      const w = topWin();
      if (info.courseId && info.clazzId && info.chapterId && w.PCount && typeof w.PCount.next === 'function') {
        log('调用 PCount.next', info.tabCount, info.chapterId);
        w.PCount.next(String(info.tabCount), info.chapterId, info.courseId, info.clazzId, '');
        return 'pcount';
      }
    } catch (e) { log('PCount.next 不可用：', e && e.message); }

    const items = catalogItems(d);
    if (!items.length) return null;
    let idx = items.findIndex((el) => el === info.active || (info.active && info.active.contains(el)));
    if (idx === -1) idx = items.findIndex((el) => el.closest('.posCatalog_active') === info.active);
    const next = items[idx + 1];
    if (!next) return null;
    log('点击章节列表下一项：', (next.textContent || '').trim().slice(0, 30));
    next.click();
    return 'catalog';
  }

  // ---------- 10 分钟卡死后的升级处置 ----------
  function openQuizTab(d) {
    const tabs = Array.from(d.querySelectorAll('a,li,div,span'))
      .filter((el) => el.offsetParent !== null && /^\d*\s*学习测验$/.test((el.textContent || '').replace(/\s+/g, '')))
      .filter((el) => !/active|cur/i.test(el.className || ''));
    if (!tabs.length) return false;
    tabs[0].click();
    return true;
  }

  // 找视频（可能在章节 iframe 里）
  function findVideo() {
    const walk = (win, depth) => {
      if (depth > 4) return null;
      let doc; try { doc = win.document; } catch (e) { return null; }
      if (!doc) return null;
      const v = doc.querySelector('video, #video_html5_api');
      if (v) return v;
      let subs = []; try { subs = Array.from(win.frames); } catch (e) {}
      for (const w of subs) { const r = walk(w, depth + 1); if (r) return r; }
      return null;
    };
    try { return walk(top, 0); } catch (e) { return walk(window, 0); }
  }

  function resumeVideo() {
    const v = findVideo();
    if (!v) return false;
    if (!v.paused || v.ended) return false;
    try { v.play(); return true; } catch (e) {}
    const btn = v.closest('.video-js') ? v.closest('.video-js').querySelector('.vjs-play-control, .vjs-big-play-button') : null;
    if (btn) { btn.click(); return true; }
    return false;
  }

  async function escalate(d, info) {
    state.escalateCount++;
    const n = state.escalateCount;
    log('升级处置 #' + n + '：当前章节', info.name);

    // 第一招：视频被暂停了（或卡住不动）→ 拉起来接着放
    if (n === 1) {
      if (resumeVideo()) {
        notice('10 分钟没推进：视频是暂停状态，已帮你点播放', 'rgba(217,119,6,.95)');
        await sleep(4000);
        return;
      }
    }

    // 第二招：本节测验没做完往往是卡住的原因，切到测验让刷分脚本处理
    if (n === 2) {
      if (openQuizTab(d)) {
        notice('10 分钟没推进：先切到「学习测验」把它做掉…', 'rgba(217,119,6,.95)');
        await sleep(3000);
        return;
      }
    }

    // 第三招：强制点下一节
    if (n === 3) {
      const how = clickNextChapter(d, info);
      notice(how ? '10 分钟没推进：强制点了下一节（' + how + '）' : '10 分钟没推进：也没找到下一节入口…',
        how ? 'rgba(217,119,6,.95)' : 'rgba(220,38,38,.95)');
      await sleep(4000);
      return;
    }

    // 第四招：整页刷新，让 OCS 重新注入、重新跑（最快恢复“刷课”的办法）
    if (n === 4) {
      let lastReload = 0;
      try { lastReload = parseInt(localStorage.getItem('cxar_last_reload') || '0', 10); } catch (e) {}
      if (Date.now() - lastReload < 5 * 60 * 1000) {
        notice('刚刷新过还没恢复，等一会儿再说（不重复刷新）', 'rgba(217,119,6,.95)');
        return;
      }
      try { localStorage.setItem('cxar_last_reload', String(Date.now())); } catch (e) {}
      notice('10 分钟没推进：刷新本节页面，让 OCS 重新接管…', 'rgba(217,119,6,.95)');
      log('刷新页面做软恢复');
      await sleep(1200);
      location.reload();
      return;
    }

    // 再往后：告警，别乱点了
    notice('卡住超过 10 分钟：' + (info.name || '当前章节') + ' 可能被「测验限次 / 闯关锁章 / 人脸识别」挡住，请手动看一眼', 'rgba(220,38,38,.95)');
    log('放弃自动升级，等待人工');
  }

  // ---------- 主循环 ----------
  async function tick() {
    if (!isStudyPage()) return;
    const d = topDoc();
    if (!d) return;

    const info = readChapter(d);
    if (!info.active) {
      notice('没找到章节列表，等待页面加载…', 'rgba(107,114,128,.9)');
      return;
    }

    // 换章了：全部重置
    if (info.chapterId && info.chapterId !== state.chapterId) {
      if (state.chapterId) log('已跳转到新章节：', state.chapterId, '←', info.chapterId);
      state.chapterId = info.chapterId;
      state.idleSince = Date.now();
      state.attempts = 0;
      state.lastActionAt = 0;
      state.done = false;
      state.lastAlive = Date.now();
      state.escalateCount = 0;
    }

    // 有东西在推进（视频在放 / 题目在做）→ 刷新“活着”时间，不升级
    if (hasRunningJob(d)) {
      state.lastAlive = Date.now();
      state.idleSince = Date.now();
      state.attempts = 0;
      notice('检测到视频/题目仍在进行，先等它完成…', 'rgba(107,114,128,.85)');
      return;
    }

    if (!info.completed) {
      state.idleSince = Date.now();
      state.attempts = 0;
      // 没完成但也没在动，超过 10 分钟同样要升级
      maybeEscalate(d, info);
      notice('当前章节还有任务点，正常学习中…', 'rgba(107,114,128,.85)');
      return;
    }

    // 任务点已完成：先给 OCS 和页面 8 秒自己跳
    const idleMs = Date.now() - state.idleSince;
    if (idleMs < WAIT_BEFORE_JUMP) {
      notice(`本节任务点已完成，等 ${Math.ceil((WAIT_BEFORE_JUMP - idleMs) / 1000)}s 看页面是否自动跳…`);
      return;
    }

    if (state.attempts >= MAX_TRIES) {
      if (!state.done) {
        notice('试了 10 次还是没跳过去，请手动点一下"下一节"（章节可能被锁/闯关）', 'rgba(220,38,38,.95)');
        log('放弃：10 次尝试均未跳转');
        state.done = true;
      }
      maybeEscalate(d, info);
      return;
    }

    if (Date.now() - state.lastActionAt < RETRY_GAP) return;

    state.attempts++;
    state.lastActionAt = Date.now();
    state.lastAlive = Date.now();
    notice(`第 ${state.attempts} 次尝试跳转…（下一节元素/接口可能还没出来，会一直重试）`);
    const how = clickNextChapter(d, info);
    if (!how) {
      notice(`第 ${state.attempts} 次：还没找到"下一节"，5s 后重试…`, 'rgba(217,119,6,.9)');
      return;
    }

    await sleep(8000);
    const after = readChapter(topDoc());
    if (after.chapterId && after.chapterId !== state.chapterId) {
      log('跳转成功 →', after.chapterId);
      state.chapterId = after.chapterId;
      state.idleSince = Date.now();
      state.lastAlive = Date.now();
      state.attempts = 0;
    } else {
      log('跳转没生效，继续重试');
    }
  }

  function maybeEscalate(d, info) {
    const idle = Date.now() - state.lastAlive;
    if (idle < STALL_MS) return;
    if (Date.now() - state.lastEscalateAt < ESCALATE_GAP) return;
    state.lastEscalateAt = Date.now();
    escalate(d, info).catch((e) => log('升级出错：', e));
  }

  log('已启动（10 分钟无推进会自动升级处置）');
  notice('已启动，等待本节任务点完成…');
  setInterval(() => { tick().catch((e) => log('循环出错：', e)); }, 3000);
  tick().catch(() => {});
})();
