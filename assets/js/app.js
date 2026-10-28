/* 海斗指南 · 前端（数据源：海斗一图流 16.21，全部为真实对局统计） */
(function () {
  'use strict';

  /* ---------- 小工具 ---------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 胜率：一位小数 + 百分号
  const pct = (n) => (n == null ? '—' : Number(n).toFixed(1) + '%');
  // 大样本量压缩显示
  const fmtN = (n) => (n == null ? '—' : n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n));

  const img = (src, cls, alt) =>
    src
      ? `<img src="${esc(src)}" class="${cls || ''}" alt="${esc(alt || '')}" loading="lazy" decoding="async" onerror="this.classList.add('img-fail')">`
      : `<span class="img-miss ${cls || ''}">?</span>`;

  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {}
    },
  };

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  /* ---------- 常量 ---------- */
  const RAR = { prismatic: '棱彩', gold: '金色', silver: '银色' };
  const RAR_ORDER = ['prismatic', 'gold', 'silver'];
  const TIER_RANK = { SSS: 6, SS: 5, S: 4, A: 3, B: 2, C: 1, D: 0 };
  const tierCls = (t) => {
    const s = String(t || '').toUpperCase();
    return TIER_RANK[s] != null ? s.toLowerCase() : '';
  };

  const savedFavs = LS.get('hd_favs', []);
  const initFavs = Array.isArray(savedFavs) ? savedFavs.filter((x) => typeof x === 'string') : [];

  const S = {
    index: [],
    augments: [],
    items: [],
    augById: {},
    augByName: {},
    itemById: {},
    itemByName: {},
    meta: {},
    bySlug: {},
    hero: null,
    build: 0, // 当前流派下标
    augFilter: 'all',
    favs: initFavs,
    expand: {}, // 海克斯列表是否展开
    plans: {}, // 小程序「核心构建方案」，按英雄 slug 分组
    augIcon: {}, // 海克斯名 → 256px 高清图标
  };

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    let index = [],
      augments = [],
      items = [],
      meta = {};
    try {
      const res = await Promise.all([
        getJSON('data/index.json'),
        getJSON('data/augments.json'),
        getJSON('data/items.json'),
        getJSON('data/meta.json').catch(() => ({})),
      ]);
      index = res[0];
      augments = res[1];
      items = res[2];
      meta = res[3];
    } catch (e) {
      $('#content').innerHTML = `<div class="notice warn"><span class="ni">!</span><div>数据加载失败：${esc(e.message)}</div></div>`;
      return;
    }

    S.index = index;
    S.augments = augments;
    S.items = items;
    S.meta = meta;
    augments.forEach((a) => {
      if (a.id != null) S.augById[a.id] = a;
      if (a.name) S.augByName[a.name] = a;
    });
    items.forEach((i) => {
      if (i.id != null) S.itemById[i.id] = i;
      if (i.name) S.itemByName[i.name] = i;
    });
    index.forEach((h) => (S.bySlug[h.slug] = h));

    $('#heroCount').textContent = index.length;
    const pi = $('#patchInfo');
    if (pi) {
      const v = meta.version || '';
      const d = meta.dataDate || '';
      pi.innerHTML = v ? `<b>${esc(v)}</b>${d ? ` · ${esc(d)} 数据` : ''}` : '';
    }
    renderList();

    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (hash) {
      const hit =
        S.bySlug[hash] ||
        index.find((h) => h.slug.toLowerCase() === hash.toLowerCase() || h.name === hash);
      if (hit) return openHero(hit.slug);
    }
    // 没指定英雄就打开当前排名第一的
    if (index.length) openHero(index[0].slug);

    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 400));
    idle(() => ensurePY());
  }

  /* 构建方案（小程序「核心构建方案」）体较大，开英雄时才拉，不拖慢首屏 */
  let planLoad = null;
  function ensurePlans() {
    if (planLoad) return planLoad;
    planLoad = Promise.all([
      getJSON('data/plans.json').catch(() => ({})),
      getJSON('data/augicon.json').catch(() => ({})),
    ]).then(([p, ic]) => {
      S.plans = p;
      S.augIcon = ic;
      return p;
    });
    return planLoad;
  }

  /* ---------- 搜索：中文 / 称号 / 拼音 / 首字母 / 容错 ---------- */
  let PY = null;
  let pyLoading = null;
  function loadPY() {
    if (pyLoading) return pyLoading;
    pyLoading = fetch('data/pinyin.txt')
      .then((r) => (r.ok ? r.text() : ''))
      .then((txt) => {
        PY = new Map();
        txt.split('\n').forEach((line) => {
          const i = line.indexOf(':');
          if (i < 1) return;
          const py = line.slice(0, i);
          for (const ch of line.slice(i + 1)) PY.set(ch, py);
        });
        return PY;
      })
      .catch(() => (PY = new Map()));
    return pyLoading;
  }
  function pyOf(s) {
    if (!PY) return '';
    let out = '';
    for (const ch of s) out += PY.get(ch) || ch;
    return out;
  }
  function ensurePY() {
    if (PY) return Promise.resolve(PY);
    return loadPY().then((m) => {
      const v = $('#q').value;
      if (v && v.trim()) renderList(v);
      return m;
    });
  }
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length,
      n = b.length;
    if (!m) return n;
    if (!n) return m;
    if (Math.abs(m - n) > 3) return 99;
    let prev = [];
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const typoLimit = (n) => (n >= 8 ? 3 : n >= 5 ? 2 : 1);
  const isCN = (s) => /[\u4e00-\u9fa5]/.test(s);

  function heroScore(h, kw, kwPy) {
    let best = 0;
    for (const raw of [h.name, h.title, h.slug].concat(h.aliases || [])) {
      const n = String(raw).toLowerCase();
      if (n === kw) best = Math.max(best, 100);
      else if (n.indexOf(kw) === 0) best = Math.max(best, 92);
      else if (n.includes(kw)) best = Math.max(best, 84);
      else if (kw.length >= 3 && isCN(kw) && lev(n, kw) <= 1) best = Math.max(best, 56);
    }
    const pq = kwPy && /[a-z]/.test(kwPy) ? kwPy : /^[a-z]+$/.test(kw) ? kw : '';
    if (pq) {
      for (const pair of h.py || []) {
        const full = pair[0],
          ini = pair[1];
        if (full === pq || ini === pq) best = Math.max(best, 96);
        else if (full.indexOf(pq) === 0 || ini.indexOf(pq) === 0) best = Math.max(best, 88);
        else if (pq.length >= 3 && (full.includes(pq) || ini.includes(pq))) best = Math.max(best, 74);
        else if (pq.length >= 2) {
          const d = Math.min(lev(full, pq), lev(ini, pq));
          if (d <= typoLimit(pq.length)) best = Math.max(best, d === 1 ? 66 : 52);
        }
      }
    }
    return best;
  }

  function searchHeroes(q) {
    const kw = (q || '').trim().toLowerCase();
    if (!kw) return { list: S.index, best: 0 };
    const kwPy = isCN(kw) ? pyOf(kw) : '';
    const hits = [];
    for (const h of S.index) {
      const s = heroScore(h, kw, kwPy);
      if (s) hits.push({ h, s });
    }
    hits.sort((a, b) => b.s - a.s || (b.h.win || 0) - (a.h.win || 0));
    const best = hits.length ? hits[0].s : 0;
    const cut = best >= 88 ? best - 30 : 0;
    return { list: hits.filter((x) => x.s >= cut).map((x) => x.h), best };
  }

  /* ---------- 侧栏英雄列表 ---------- */
  function heroCard(h, isFav) {
    const on = S.hero && S.hero.slug === h.slug;
    return `<button class="hcard${on ? ' on' : ''}${isFav ? ' fav' : ''}" data-slug="${esc(h.slug)}" title="${esc(h.name + ' ' + h.title + ' · 胜率 ' + pct(h.win))}">
      ${img(faceOf(h.slug), 'hc-img', h.name)}
      ${h.win != null ? `<span class="hc-wr">${h.win.toFixed(1)}</span>` : ''}
      <span class="hc-nm">${esc(h.name)}</span>
      <span class="hc-star" data-fav="${esc(h.slug)}" title="收藏">★</span>
    </button>`;
  }

  function renderList(kw) {
    const q = (kw || '').trim();
    const found = q ? searchHeroes(q) : { list: S.index, best: 0 };
    const list = found.list;
    $('#heroCount').textContent = q ? `${list.length} / ${S.index.length}` : S.index.length;

    const favSet = new Set(S.favs);
    const favHeroes = S.favs.map((s) => S.bySlug[s]).filter(Boolean);
    let html = '';
    if (!q && favHeroes.length) {
      html += `<div class="grid-label">收藏 ${favHeroes.length}</div>`;
      html += favHeroes.map((h) => heroCard(h, true)).join('');
      html += `<div class="grid-label">全部英雄</div>`;
    }
    if (q && list.length && found.best < 80) html += `<div class="grid-label">近似匹配 · ${list.length} 个</div>`;
    html += list.map((h) => heroCard(h, favSet.has(h.slug))).join('');
    if (!list.length) {
      html = `<div class="empty-hit">
        <b>没找到「${esc(q)}」</b>
        <span>试试拼音首字母：<i>zdr</i> 炸弹人 · <i>jj</i> 剑姬 · <i>ys</i> 亚索</span>
        <span>打错字也认得：<i>剪辑</i> → 剑姬</span>
      </div>`;
    }
    $('#heroGrid').innerHTML = html;
  }

  let listTimer = null;
  $('#q').addEventListener('input', (e) => {
    $('#qClear').classList.toggle('on', !!e.target.value);
    clearTimeout(listTimer);
    listTimer = setTimeout(() => renderList(e.target.value), 110);
    if (!PY) ensurePY();
  });
  $('#qClear').addEventListener('click', () => {
    $('#q').value = '';
    $('#qClear').classList.remove('on');
    renderList('');
    $('#q').focus();
  });

  $('#heroGrid').addEventListener('click', (e) => {
    const star = e.target.closest('[data-fav]');
    if (star) {
      e.stopPropagation();
      toggleFav(star.dataset.fav);
      return;
    }
    const card = e.target.closest('.hcard');
    if (card) {
      openHero(card.dataset.slug);
      closeSide();
    }
  });

  function toggleFav(slug) {
    if (!slug) return;
    const i = S.favs.indexOf(slug);
    if (i >= 0) S.favs.splice(i, 1);
    else S.favs.unshift(slug);
    LS.set('hd_favs', S.favs);
    paintFavBtn();
    renderList($('#q').value);
    toast(i >= 0 ? '已取消收藏' : '已收藏，侧栏置顶');
  }

  function paintFavBtn() {
    const btn = $('#favBtn');
    if (!btn || !S.hero) return;
    const on = S.favs.includes(S.hero.slug);
    btn.classList.toggle('on', on);
    btn.querySelector('span').textContent = on ? '已收藏' : '收藏';
  }

  /* ---------- 手机侧栏 ---------- */
  function openSide() {
    $('#sidebar').classList.add('open');
    $('#sideMask').classList.add('open');
  }
  function closeSide() {
    $('#sidebar').classList.remove('open');
    $('#sideMask').classList.remove('open');
  }
  $('#openSide').addEventListener('click', openSide);
  $('#sideMask').addEventListener('click', closeSide);

  /* ---------- 打开英雄 ---------- */
  let heroSeq = 0;
  async function openHero(slug) {
    const seq = ++heroSeq;
    try {
      const d = await getJSON(`data/heroes/${slug}.json`);
      if (seq !== heroSeq) return;
      S.hero = d;
      S.build = 0;
      S.augFilter = 'all';
      S.expand = {};
      S.planAll = false;
      history.replaceState(null, '', '#' + encodeURIComponent(slug));
      renderHero();
      renderList($('#q').value);
      window.scrollTo({ top: 0, behavior: 'auto' });
      // 构建方案随后到，到了再补渲染，不阻塞首屏
      ensurePlans().then(() => {
        if (seq !== heroSeq) return;
        if ($('#pageBody')) renderBody();
        const qn = $('#quickNav');
        if (qn) qn.innerHTML = quickNavHTML();
      });
    } catch (err) {
      if (seq !== heroSeq) return;
      $('#content').innerHTML = `<div class="notice warn"><span class="ni">!</span><div>加载失败：${esc(err.message)}</div></div>`;
    }
  }

  /* ---------- 头像 + 徽章 ---------- */
  // 官方立绘裁出的 256px 头像、1215px 官方原版海报，比数据源自带的 96px 小图清晰得多
  const faceOf = (slug) => `assets/zhishi/face/${slug}.jpg`;
  const posterOf = (slug) => `assets/zhishi/poster/${slug}.webp`;

  /* 海克斯图标：小程序素材是 256px，比数据源自带的 64px 清晰；没有高清版才回退 */
  function hiAug(name, fallback) {
    return (S.augIcon && S.augIcon[name]) || fallback || '';
  }

  function tierBadge(t) {
    if (!t) return '';
    return `<span class="tbadge t-${tierCls(t) || 'na'}">${esc(t)}</span>`;
  }

  /* 切换英雄时换整页背景海报（用 <img> 精确控位，不 cover 拉大导致模糊） */
  function paintPoster() {
    const h = S.hero;
    const bg = $('#heroBgImg');
    if (!bg || !h) return;
    const url = posterOf(h.slug);
    const pre = new Image();
    pre.onload = function () {
      bg.src = url;
      bg.classList.add('on');
    };
    pre.onerror = function () {
      bg.removeAttribute('src');
      bg.classList.remove('on');
    };
    pre.src = url;
  }

  /* 顶部四段锚点：只滚动定位，不隐藏内容 */
  function quickNavHTML() {
    const b = curBuild();
    const augN = b ? RAR_ORDER.reduce((n, k) => n + ((b.augs[k[0]] || []).length), 0) : 0;
    const spN = (S.hero.special || []).length;
    const planN = ((S.plans || {})[S.hero.slug] || []).length;
    const items = [
      { id: 'sec-plan', n: '构建方案', c: planN ? String(planN) : '', hide: !planN },
      { id: 'sec-gear', n: '推荐出装', c: b ? String((b.six || []).length) : '' },
      { id: 'sec-aug', n: '推荐海克斯', c: augN ? String(augN) : '' },
      { id: 'sec-game', n: '常规玩法', c: '' },
      { id: 'sec-sp', n: '特殊玩法', c: spN ? String(spN) : '', hide: !spN },
    ];
    return items
      .filter((x) => !x.hide)
      .map(
        (x) =>
          `<button class="qn" data-jump="${x.id}">${x.n}${x.c ? `<i>${x.c}</i>` : ''}</button>`
      )
      .join('');
  }

  /* ---------- 英雄页：头部 ---------- */
  function renderHero() {
    const h = S.hero;
    const r = h.rank || {};
    const aliasList = ((S.bySlug[h.slug] || {}).aliases || []).filter(
      (a) => a !== h.name && a !== h.title && !/^[a-z]+$/i.test(a) && a.length <= 6
    );

    $('#content').innerHTML = `
      <section class="hero-head">
        <div class="hh-banner"></div>
        <div class="hh-main">
          <div class="hh-avatar">
            ${img(faceOf(h.slug), '', h.name)}
            <span class="hh-frame"></span>
            ${r.tier ? `<span class="hh-tierline t-${tierCls(r.tier) || 'na'}">${esc(r.tier)}</span>` : ''}
          </div>
          <div class="hh-id">
            <div class="hh-name">
              <h1>${esc(h.name)}</h1>
              <span class="hh-title">${esc(h.title)}</span>
            </div>
            ${aliasList.length ? `<div class="hh-tags">${aliasList.map((a) => `<span class="hh-tag">${esc(a)}</span>`).join('')}</div>` : ''}
            <div class="hh-stats">
              <div class="hs hs-wr"><b>${pct(r.win)}</b><span>胜率</span></div>
              <div class="hs"><b>${pct(r.pick)}</b><span>选取率</span></div>
              <div class="hs"><b>#${r.rank != null ? r.rank : '—'}</b><span>全站排名</span></div>
              <div class="hs"><b>${fmtN(r.sample)}</b><span>对局样本</span></div>
            </div>
          </div>
          <div class="hh-side">
            <div class="hh-box">
              <span class="hb-lb">召唤师技能</span>
              <div class="hb-row">
                ${(h.spells || []).map((s) => `<span class="spell">${img(s.ic, '', s.n)}<em>${esc(s.n)}</em></span>`).join('') ||
                  '<span class="dimtxt">—</span>'}
              </div>
            </div>
            <div class="hh-box">
              <span class="hb-lb">技能加点</span>
              <div class="hb-row">
                ${
                  h.order
                    ? `<span class="order-txt">${esc(h.order)}</span>`
                    : '<span class="dimtxt">—</span>'
                }
                ${(h.abil || []).map((a) => `<span class="ab-ic" title="${esc(a.n)}">${img(a.ic, '', a.n)}<i>${esc(a.k)}</i></span>`).join('')}
              </div>
            </div>
          </div>
          <div class="hh-acts">
            <button class="act${S.favs.includes(h.slug) ? ' on' : ''}" id="favBtn">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.6l2.9 6.2 6.8.9-5 4.7 1.3 6.7-6-3.3-6 3.3 1.3-6.7-5-4.7 6.8-.9z"/></svg>
              <span>${S.favs.includes(h.slug) ? '已收藏' : '收藏'}</span>
            </button>
            <button class="act" id="shareBtn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.6 1.6"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.6-1.6"/></svg>
              <span>分享</span>
            </button>
          </div>
        </div>
      </section>

      <nav class="play-tabs" id="playTabs">${playTabsHTML()}</nav>
      <nav class="quick-nav" id="quickNav">${quickNavHTML()}</nav>

      <div class="page-body" id="pageBody"></div>
    `;
    paintPoster();
    renderBody();
  }

  /* 流派切换条：主流派 + 特殊玩法 */
  function playTabsHTML() {
    const h = S.hero;
    const builds = h.builds || [];
    const spN = (h.special || []).length;
    let html = builds
      .map(
        (b, i) =>
          `<button class="pt${i === S.build ? ' on' : ''}" data-build="${i}">
            <span class="pt-n">${esc(b.n)}</span>
            <span class="pt-w">${pct(b.win)}</span>
          </button>`
      )
      .join('');
    if (spN) {
      html += `<button class="pt pt-sp${S.build === -1 ? ' on' : ''}" data-build="-1">
        <span class="pt-n">特殊玩法</span>
        <span class="pt-w">${spN} 套</span>
      </button>`;
    }
    return html;
  }

  function curBuild() {
    const h = S.hero;
    if (!h || !h.builds || !h.builds.length) return null;
    if (S.build < 0) return null;
    return h.builds[Math.min(S.build, h.builds.length - 1)];
  }

  /* 只重绘正文，头部与切换条不闪 */
  function renderBody() {
    const box = $('#pageBody');
    if (!box) return;
    box.innerHTML = S.build === -1 ? viewSpecial() : viewBuild();
    $$('#playTabs .pt').forEach((b) => b.classList.toggle('on', Number(b.dataset.build) === S.build));
  }

  /* ---------- 通用小组件 ---------- */
  function itemCell(it, idx, cls) {
    if (!it) return '';
    const full = (it.i != null && S.itemById[it.i]) || S.itemByName[it.n] || {};
    const price = it.pr || full.price;
    const win = it.w != null ? it.w : full.win;
    const pick = it.p != null ? it.p : full.pick;
    const tip = [
      it.n,
      price ? price + ' 金币' : '',
      win ? '胜率 ' + pct(win) : '',
      pick ? '选取 ' + pct(pick) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<button class="gitem${cls ? ' ' + cls : ''}" data-item="${it.i != null ? it.i : esc(it.n)}" title="${esc(tip)}">
      <span class="gi-box">${img(it.ic || full.icon, '', it.n)}${idx ? `<i class="gi-idx">${idx}</i>` : ''}</span>
      <span class="gi-nm">${esc(it.n)}</span>
    </button>`;
  }

  function gearRow(list, label, opts) {
    if (!list || !list.length) return '';
    const o = opts || {};
    const core = o.core || 0; // 前 N 件标记为核心件
    return `<div class="gear-row">
      <div class="gear-lb">${esc(label)}${o.hint ? `<i>${esc(o.hint)}</i>` : ''}</div>
      <div class="gear-items">${list
        .map((it, i) => itemCell(it, o.num ? i + 1 : 0, i < core ? 'is-core' : ''))
        .join('')}</div>
    </div>`;
  }

  function augMini(a) {
    const rar = a.r || 'gold';
    return `<button class="amini r-${rar}" data-aug="${a.i != null ? a.i : esc(a.n)}" title="${esc(a.n)} · ${RAR[rar] || rar}">
      ${img(hiAug(a.n, a.ic), '', a.n)}<em>${esc(a.n)}</em>
    </button>`;
  }

  /* ---------- 区块头 ---------- */
  function secHead(title, right, sub) {
    return `<div class="sec-head">
      <h3>${title}</h3>
      ${sub ? `<span class="sec-sub">${sub}</span>` : ''}
      <div class="sec-line"></div>
      ${right || ''}
    </div>`;
  }

  /* ---------- 正文：常规流派 ---------- */
  function viewBuild() {
    const h = S.hero;
    const b = curBuild();
    if (!b) return `<div class="notice"><span class="ni">i</span><div>这个英雄暂无流派数据。</div></div>`;

    // 特殊玩法有独立入口（流派条最后一项），这里不再重复铺一遍
    return (
      buildGear(b) +
      buildPlansSec() +
      buildAugs(b) +
      buildCombos(b) +
      buildGame(h) +
      buildTips(h) +
      buildSkills(h)
    );
  }

  /* ---------- 核心构建方案（来自海斗小程序） ---------- */
  const TIER_CLS = { SSS: 'sss', SS: 'ss', S: 's', A: 'a', B: 'b', C: 'c' };

  function planTierBadge(t) {
    return `<span class="pl-tier t-${TIER_CLS[t] || 'a'}">${esc(t || 'A')}</span>`;
  }

  function planAugChip(a) {
    const rar = a.r || 'gold';
    return `<span class="pl-aug r-${rar}" data-aug="${esc(a.n)}" title="${esc(a.n)}">
      ${img(hiAug(a.n, a.ic), '', a.n)}<em>${esc(a.n)}</em>
    </span>`;
  }

  function planItemChip(it) {
    return `<span class="pl-item" data-item="${esc(it.n)}" title="${esc(it.n)}">
      ${img(it.ic, '', it.n)}<em>${esc(it.n)}</em>
    </span>`;
  }

  /* 空行不占位，避免出现一排孤零零的破折号 */
  function planRow(label, arr, render) {
    if (!arr || !arr.length) return '';
    return `<div class="pl-row">
      <span class="pl-lb">${esc(label)}</span>
      <div class="pl-val">${arr.map(render).join('')}</div>
    </div>`;
  }

  function buildPlansSec() {
    const list = (S.plans && S.plans[S.hero.slug]) || [];
    if (!list.length) return '';
    // 默认只铺前 6 套，其余折叠
    const LIMIT = 6;
    const show = S.planAll ? list : list.slice(0, LIMIT);

    const cards = show
      .map(
        (p, i) => `<div class="pl-card">
        <div class="pl-hd">
          ${planTierBadge(p.t)}
          <h4>${esc(p.n)}</h4>
          ${p.u ? '<span class="pl-user">玩家</span>' : ''}
          <button class="pl-more" data-plan="${i}">查看详情</button>
        </div>
        ${p.f && p.f.length ? `<div class="pl-forge">${p.f.map((f) => `<i>${esc(f)}</i>`).join('<b>›</b>')}</div>` : ''}
        <div class="pl-body">
          ${planRow('核心', p.ca, planAugChip)}
          ${planRow('备选', p.aa, planAugChip)}
          ${planRow('装备', p.it, planItemChip)}
        </div>
        ${p.d ? `<p class="pl-desc">${esc(p.d)}</p>` : ''}
      </div>`
      )
      .join('');

    const more =
      list.length > LIMIT
        ? `<button class="more-btn" data-planmore="1">${S.planAll ? '收起' : `展开剩余 ${list.length - LIMIT} 套方案`}</button>`
        : '';

    const ss = list.filter((p) => p.t === 'SS' || p.t === 'SSS').length;
    return `<section class="sec" id="sec-plan">
      ${secHead('核心构建方案', '', `海斗小程序 · 共 ${list.length} 套${ss ? ` · 其中 ${ss} 套 SS` : ''}`)}
      <div class="pl-list">${cards}</div>
      ${more}
    </section>`;
  }

  /* 方案详情弹层 */
  function openPlan(i) {
    const list = (S.plans && S.plans[S.hero.slug]) || [];
    const p = list[i];
    if (!p) return;

    const augBlock = (title, arr, cls) =>
      arr && arr.length
        ? `<div class="pl-blk">
            <div class="pl-blk-lb">${title}<i>${arr.length}</i></div>
            <div class="pl-blk-val ${cls}">${arr.map(planAugChip).join('')}</div>
          </div>`
        : '';

    showModal(`
      <div class="bd-hd">
        ${planTierBadge(p.t)}
        <div class="bd-id">
          <h3>${esc(p.n)}</h3>
          <div class="bd-tags">${p.u ? '<span class="pl-user">玩家创建</span>' : '<span class="dimtxt">海斗官方</span>'}</div>
        </div>
        <button class="m-x" data-close aria-label="关闭">✕</button>
      </div>
      <div class="bd-body">
        ${p.d ? `<p class="bd-desc">${esc(p.d)}</p>` : ''}
        ${p.f && p.f.length ? `<div class="pl-forge big">${p.f.map((f) => `<i>${esc(f)}</i>`).join('<b>›</b>')}</div>` : ''}
        ${augBlock('核心海克斯', p.ca, 'core')}
        ${augBlock('备选海克斯', p.aa, 'alt')}
        ${
          p.it && p.it.length
            ? `<div class="pl-blk">
                <div class="pl-blk-lb">推荐装备<i>${p.it.length}</i></div>
                <div class="pl-blk-val items">${p.it.map(planItemChip).join('')}</div>
              </div>`
            : ''
        }
        ${p.tip ? `<p class="pl-tip">${esc(p.tip)}</p>` : ''}
      </div>
    `);
  }

  /* 推荐出装：核心三件就是六件的前三件，合并成一段不再重复展示 */
  function buildGear(b) {
    const stat = [
      `胜率 <b>${pct(b.win)}</b>`,
      `选取 <b>${pct(b.pick)}</b>`,
      b.sample ? `样本 ${fmtN(b.sample)}` : '',
      b.low ? '样本偏少' : '',
    ]
      .filter(Boolean)
      .join(' · ');

    return `<section class="sec" id="sec-gear">
      ${secHead('推荐出装', '', stat)}
      <div class="gear-box">
        ${gearRow(b.start, '出门装')}
        ${gearRow(b.six, '六件成装', { hint: '前 3 件为核心', num: true, core: 3 })}
      </div>
    </section>`;
  }

  /* 海克斯推荐 */
  function buildAugs(b) {
    const groups = RAR_ORDER.map((k) => ({
      k,
      list: (b.augs[k[0]] || []).slice().sort((x, y) => (y.w || 0) - (x.w || 0)),
    })).filter((g) => g.list.length);

    const total = groups.reduce((n, g) => n + g.list.length, 0);
    const show = groups.filter((g) => S.augFilter === 'all' || g.k === S.augFilter);
    const LIMIT = 6; // 每档默认显示前 6 个，够看又不至于太长
    const expanded = !!S.expand[b.k];

    const filters = `<div class="chips">
      ${[{ k: 'all', n: '全部' }]
        .concat(RAR_ORDER.map((k) => ({ k, n: RAR[k] })))
        .map(
          (f) =>
            `<button class="chip c-${f.k}${S.augFilter === f.k ? ' on' : ''}" data-afilter="${f.k}">${f.n}</button>`
        )
        .join('')}
    </div>`;

    let rows = '';
    let shown = 0;
    for (const g of show) {
      const list = expanded ? g.list : g.list.slice(0, LIMIT);
      shown += list.length;
      rows += `<div class="aug-group">
        <div class="ag-lb"><span class="rar-dot r-${g.k}"></span>${RAR[g.k]}<i>${g.list.length}</i></div>
        <div class="aug-list">${list.map((a, i) => augRow(a, i + 1)).join('')}</div>
      </div>`;
    }

    const hiddenCount = total - shown;
    const more =
      hiddenCount > 0
        ? `<button class="more-btn" data-expand="1">展开剩余 ${hiddenCount} 个海克斯</button>`
        : expanded && total > LIMIT
        ? `<button class="more-btn" data-expand="0">收起</button>`
        : '';

    return `<section class="sec" id="sec-aug">
      ${secHead('海克斯推荐', filters, `按本英雄胜率排序 · 共 ${total} 个`)}
      ${rows}
      ${more}
    </section>`;
  }

  function augRow(a, idx) {
    const rar = a.r || 'gold';
    return `<button class="aug r-${rar}" data-aug="${a.i != null ? a.i : esc(a.n)}">
      <span class="aug-rk">${idx}</span>
      <span class="aug-ic">${img(hiAug(a.n, a.ic), '', a.n)}</span>
      <span class="aug-bd">
        <span class="aug-nm">${esc(a.n)}<em class="rar-tag r-${rar}">${RAR[rar] || rar}</em></span>
        ${a.t ? `<span class="aug-tier">${esc(a.t)} 级</span>` : ''}
      </span>
      <span class="aug-w">${pct(a.w)}<i>胜率</i></span>
      <span class="aug-p">${pct(a.p)}<i>选取</i></span>
    </button>`;
  }

  /* 高胜率组合 */
  function buildCombos(b) {
    const list = (b.combos || []).slice().sort((x, y) => (y.w || 0) - (x.w || 0)).slice(0, 6);
    if (!list.length) return '';
    return `<section class="sec" id="sec-combo">
      ${secHead('高胜率海克斯组合', '', '同时拿到这两个，胜率明显更高')}
      <div class="combo-list">
        ${list
          .map(
            (c, i) => `<div class="combo">
            <span class="cb-rk">${i + 1}</span>
            <span class="cb-ics">${c.ns
              .map((n) => {
                const a = S.augByName[n] || {};
                return `<span class="cb-ic" data-aug="${a.id != null ? a.id : esc(n)}" title="${esc(n)}">${img(a.icon, '', n)}</span>`;
              })
              .join('<i class="cb-plus">+</i>')}</span>
            <span class="cb-nm">${c.ns.map((n) => esc(n)).join(' + ')}</span>
            <span class="cb-w">${pct(c.w)}<i>胜率</i></span>
          </div>`
          )
          .join('')}
      </div>
    </section>`;
  }

  /* 对局思路 */
  function buildGame(h) {
    const g = h.game || [];
    if (!g.length) return '';
    return `<section class="sec" id="sec-game">
      ${secHead('对局思路', '', `${g.length} 条`)}
      <ol class="game-list">${g.map((t, i) => `<li><i>${i + 1}</i><span>${esc(t)}</span></li>`).join('')}</ol>
    </section>`;
  }

  /* 特殊玩法：需要特定海克斯才成立的套路 */
  function viewSpecial() {
    const list = S.hero.special || [];
    if (!list.length) {
      return `<div class="notice"><span class="ni">i</span><div>这个英雄暂时没有整理的特殊玩法，直接按上面的主流派出装就行。</div></div>`;
    }

    const cards = list
      .map(
        (s, i) => `<article class="sp-card">
        <div class="sp-hd">
          <span class="sp-cat">${esc(s.cat || '特殊玩法')}</span>
          <h4>${esc(s.n)}</h4>
        </div>
        ${s.sum ? `<p class="sp-sum">${esc(s.sum)}</p>` : ''}
        ${
          s.req && s.req.length
            ? `<div class="sp-line"><span class="sp-lb">必需</span><div class="sp-augs">${s.req.map(augMini).join('')}</div></div>`
            : ''
        }
        ${(s.reqAlt || [])
          .map(
            (grp, k) =>
              `<div class="sp-line"><span class="sp-lb">替代${k + 1}</span><div class="sp-augs">${grp.map(augMini).join('')}</div></div>`
          )
          .join('')}
        ${
          s.pri && s.pri.length
            ? `<div class="sp-line"><span class="sp-lb">优先</span><div class="sp-augs">${s.pri.slice(0, 10).map(augMini).join('')}</div></div>`
            : ''
        }
        ${s.items && s.items.length ? `<div class="sp-gear">${s.items.map((it, k) => itemCell(it, 0, 'sm')).join('')}</div>` : ''}
      </article>`
      )
      .join('');

    return buildPlansSec() + `<section class="sec" id="sec-sp">
      ${secHead('特殊玩法', '', `${list.length} 套 · 需要特定海克斯才成立`)}
      <div class="sp-list">${cards}</div>
    </section>`;
  }
  /* 小技巧 */
  function buildTips(h) {
    const t = h.tips || [];
    if (!t.length) return '';
    return `<section class="sec" id="sec-tip">
      ${secHead('小技巧', '', `${t.length} 条`)}
      <div class="tip-list">${t
        .map(
          (x) => `<div class="tip">
          ${
            x.els && x.els.length
              ? `<div class="tip-els">${x.els
                  .map(
                    (e) =>
                      `<span class="tip-el${e.ty === 'augment' ? ' aug' : ''}" ${
                        e.ty === 'augment' ? `data-aug="${esc(e.n)}"` : ''
                      }>${img(e.ic, '', e.n)}<em>${esc(e.n)}</em></span>`
                  )
                  .join('')}</div>`
              : ''
          }
          ${x.cond ? `<span class="tip-cond">${esc(x.cond)}</span>` : ''}
          <p>${esc(x.text)}</p>
        </div>`
        )
        .join('')}</div>
    </section>`;
  }

  /* 技能说明 + 召唤师技能 */
  function buildSkills(h) {
    const abil = h.abil || [];
    if (!abil.length) return '';
    return `<section class="sec" id="sec-skill">
      ${secHead('技能说明', h.order ? `<span class="sec-tag">加点 ${esc(h.order)}</span>` : '', '')}
      <details class="skill-fold">
        <summary>展开 ${abil.length} 个技能<span class="sf-ar">›</span></summary>
        <div class="skill-list">${abil
          .map(
            (a) => `<div class="skill">
            <span class="sk-ic">${img(a.ic, '', a.n)}<i>${esc(a.k)}</i></span>
            <span class="sk-bd"><b>${esc(a.n)}</b><span>${esc(a.d)}</span></span>
          </div>`
          )
          .join('')}</div>
      </details>
    </section>`;
  }

  /* ---------- 弹层 ---------- */
  function showModal(html) {
    const m = $('#modal');
    $('#modalCard').innerHTML = html;
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
  }
  function closeModal() {
    const m = $('#modal');
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
  }

  /* 海克斯详情 */
  function openAug(key) {
    const byId = /^\d+$/.test(String(key));
    const a = byId ? S.augById[Number(key)] : S.augByName[key] || S.augments.find((x) => x.name === key);
    // 小程序里有、统计榜单里没有的（多为新版本海克斯）：至少把图标和名字展示出来
    if (!a && !byId && S.augIcon[key]) {
      return showModal(`
        <div class="bd-hd">
          <span class="bd-ic r-gold">${img(S.augIcon[key], '', key)}</span>
          <div class="bd-id"><h3>${esc(key)}</h3></div>
          <button class="m-x" data-close aria-label="关闭">✕</button>
        </div>
        <div class="bd-body">
          <p class="bd-desc">这个海克斯在小程序构建方案里有用到，但统计榜单暂时没有它的胜率数据。</p>
        </div>`);
    }
    if (!a) return;

    const h = S.hero;
    const b = curBuild();
    let onHero = null;
    if (b) {
      onHero = []
        .concat(b.augs.p || [], b.augs.g || [], b.augs.s || [])
        .find((x) => x.i === a.id || x.n === a.name);
    }

    const heroBlock = onHero
      ? `<div class="stat-grid">
          <div><em>${esc(h.name)} 胜率</em><b class="c-up">${pct(onHero.w)}</b></div>
          <div><em>选取率</em><b>${pct(onHero.p)}</b></div>
          <div><em>样本</em><b>${fmtN(onHero.s)}</b></div>
        </div>`
      : '';

    showModal(`
      <div class="bd-hd">
        <span class="bd-ic r-${a.rarity}">${img(hiAug(a.name, a.icon), '', a.name)}</span>
        <div class="bd-id">
          <h3>${esc(a.name)}</h3>
          <div class="bd-tags">
            <span class="rar-tag r-${a.rarity}">${RAR[a.rarity] || a.rarity}</span>
            ${a.tier ? `<span class="tier-tag">${esc(a.tier)} 级</span>` : ''}
            ${a.rank ? `<span class="dimtxt">全站 #${a.rank}</span>` : ''}
          </div>
        </div>
        <button class="m-x" data-close aria-label="关闭">✕</button>
      </div>
      <div class="bd-body">
        ${a.desc ? `<p class="bd-desc">${esc(a.desc)}</p>` : ''}
        <div class="stat-grid">
          <div><em>全站胜率</em><b>${pct(a.win)}</b></div>
          <div><em>全站选取</em><b>${pct(a.pick)}</b></div>
          <div><em>样本</em><b>${fmtN(a.sample)}</b></div>
        </div>
        ${heroBlock ? `<h5 class="bd-h">在 ${esc(h.name)} 身上</h5>${heroBlock}` : ''}
        ${
          a.heroCount
            ? `<p class="bd-foot">这个海克斯在 ${a.heroCount} 个英雄身上出现过</p>`
            : ''
        }
      </div>
    `);
  }

  /* 装备详情 */
  function openItem(key) {
    const byId = /^\d+$/.test(String(key));
    const it = byId ? S.itemById[Number(key)] : S.itemByName[key];
    if (!it) return;
    showModal(`
      <div class="bd-hd">
        <span class="bd-ic r-gold">${img(it.icon, '', it.name)}</span>
        <div class="bd-id">
          <h3>${esc(it.name)}</h3>
          <div class="bd-tags">
            ${it.price ? `<span class="tier-tag">${it.price} 金币</span>` : ''}
            ${it.tier ? `<span class="tier-tag">${esc(it.tier)} 级</span>` : ''}
            ${it.rank ? `<span class="dimtxt">全站 #${it.rank}</span>` : ''}
          </div>
        </div>
        <button class="m-x" data-close aria-label="关闭">✕</button>
      </div>
      <div class="bd-body">
        ${it.desc ? `<p class="bd-desc">${esc(it.desc)}</p>` : ''}
        <div class="stat-grid">
          <div><em>全站胜率</em><b>${pct(it.win)}</b></div>
          <div><em>全站选取</em><b>${pct(it.pick)}</b></div>
          <div><em>样本</em><b>${fmtN(it.sample)}</b></div>
        </div>
      </div>
    `);
  }

  /* ---------- 三选一训练 ---------- */
  const QZ_TIERS = ['prismatic', 'gold', 'silver'];
  const QZ = {
    open: false,
    hero: null,
    round: 0,
    cards: [],
    picked: -1,
    score: [],
    best: LS.get('hd_quiz', null),
  };

  function qzPool() {
    const b = QZ.hero.builds[0];
    return [].concat(b.augs.p || [], b.augs.g || [], b.augs.s || []);
  }

  function qzDraw(tier) {
    const pool = qzPool().filter((a) => a.r === tier && a.w != null && a.s >= 300);
    if (pool.length < 3) return pool.slice(0, 3);
    let best = null;
    for (let k = 0; k < 40; k++) {
      const pick = [];
      const used = new Set();
      while (pick.length < 3) {
        const i = Math.floor(Math.random() * pool.length);
        if (used.has(i)) continue;
        used.add(i);
        pick.push(pool[i]);
      }
      const ws = pick.map((a) => a.w);
      const gap = Math.max.apply(null, ws) - Math.min.apply(null, ws);
      const mid = ws.slice().sort((a, b) => a - b)[1];
      const score = Math.abs(gap - 4.5) * 3 + Math.abs(mid - 52);
      if (!best || score < best.score) best = { score, pick };
    }
    return best.pick;
  }

  async function openQuiz() {
    const slugs = S.index.map((h) => h.slug);
    const slug = slugs[Math.floor(Math.random() * slugs.length)];
    let d;
    try {
      d = await getJSON(`data/heroes/${slug}.json`);
    } catch (e) {
      return toast('抽卡失败，再试一次');
    }
    if (!d.builds || !d.builds.length) return openQuiz();
    QZ.open = true;
    QZ.hero = d;
    QZ.round = 0;
    QZ.score = [];
    QZ.picked = -1;
    QZ.cards = qzDraw(QZ_TIERS[0]);
    if (!QZ.cards.length) {
      toast('这把没抽到合适的卡，再来一次');
      return;
    }
    qzRender();
  }

  function qzRender() {
    if (!QZ.open) return;
    const tier = QZ_TIERS[QZ.round];
    if (QZ.round >= 3) return qzResult();
    const bestIdx = QZ.cards.reduce((bi, a, i) => (a.w > QZ.cards[bi].w ? i : bi), 0);
    const cards = QZ.cards
      .map((a, i) => {
        const cls = QZ.picked < 0 ? '' : i === bestIdx ? ' best' : i === QZ.picked ? ' wrong' : ' fade';
        const full = S.augById[a.i] || {};
        return `<button class="qzc${cls}" data-qz="${i}">
          <span class="qzc-ic r-${a.r}">${img(a.ic, '', a.n)}</span>
          <span class="qzc-nm">${esc(a.n)}</span>
          <span class="qzc-ds">${esc((full.desc || '').split('\n')[0].slice(0, 42))}</span>
          <span class="qzc-stat ${QZ.picked < 0 ? 'veil' : 'r-' + a.r}">${pct(a.w)}</span>
        </button>`;
      })
      .join('');

    showModal(`
      <div class="bd-hd">
        <span class="bd-avatar">${img(QZ.hero.icon, '', QZ.hero.name)}</span>
        <div class="bd-id">
          <h3>${esc(QZ.hero.name)} · 第 ${QZ.round + 1}/3 轮</h3>
          <div class="bd-tags"><span class="rar-tag r-${tier}">${RAR[tier]}</span><span class="dimtxt">选出这个英雄胜率最高的那张</span></div>
        </div>
        <button class="m-x" data-close data-qzexit aria-label="关闭">✕</button>
      </div>
      <div class="bd-body">
        <div class="qzc-grid">${cards}</div>
        <div class="qzc-foot">
          ${
            QZ.picked < 0
              ? '<span class="dimtxt">点一张卡查看真胜率</span>'
              : `<button class="btn-main" data-qznext>${QZ.round === 2 ? '看结果' : '下一轮'}</button>`
          }
        </div>
      </div>
    `);
  }

  function qzPick(i) {
    if (QZ.picked >= 0) return;
    const best = QZ.cards.reduce((bi, a, k) => (a.w > QZ.cards[bi].w ? k : bi), 0);
    QZ.picked = i;
    const gap = Math.abs(QZ.cards[i].w - QZ.cards[best].w);
    QZ.score.push(Math.max(0, Math.round(100 - gap * 13)));
    qzRender();
  }

  function qzNext() {
    QZ.round++;
    QZ.picked = -1;
    if (QZ.round < 3) QZ.cards = qzDraw(QZ_TIERS[QZ.round]);
    qzRender();
  }

  function qzRank(avg) {
    if (avg >= 96) return '王者';
    if (avg >= 90) return '大师';
    if (avg >= 82) return '钻石';
    if (avg >= 74) return '铂金';
    if (avg >= 64) return '黄金';
    if (avg >= 50) return '白银';
    return '青铜';
  }

  function qzResult() {
    const total = QZ.score.reduce((s, x) => s + x, 0);
    const avg = Math.round(total / Math.max(1, QZ.score.length));
    const rank = qzRank(avg);
    if (!QZ.best || total > QZ.best.total) {
      QZ.best = { total, rank, at: Date.now() };
      LS.set('hd_quiz', QZ.best);
    }
    showModal(`
      <div class="bd-hd">
        <div class="bd-id"><h3>本轮成绩</h3><div class="bd-tags"><span class="dimtxt">${esc(QZ.hero.name)}</span></div></div>
        <button class="m-x" data-close data-qzexit aria-label="关闭">✕</button>
      </div>
      <div class="bd-body qzc-res">
        <div class="qzc-score">${total}<i>/ 300</i></div>
        <div class="qzc-rank">${esc(rank)}</div>
        <div class="stat-grid">
          ${QZ.score.map((s, i) => `<div><em>第 ${i + 1} 轮</em><b>${s}</b></div>`).join('')}
        </div>
        <p class="dimtxt center">历史最高 ${QZ.best ? QZ.best.total : total} · ${esc(QZ.best ? QZ.best.rank : rank)}</p>
        <div class="qzc-foot"><button class="btn-main" data-qzagain>再来一局</button></div>
      </div>
    `);
  }

  function qzExit() {
    QZ.open = false;
  }

  /* ---------- 随机 / 分享 ---------- */
  function randomHero() {
    const h = S.index[Math.floor(Math.random() * S.index.length)];
    if (!h) return;
    openHero(h.slug);
    toast('随机到 ' + h.name);
  }

  async function shareHero() {
    if (!S.hero) return;
    const url = location.origin + location.pathname + '#' + encodeURIComponent(S.hero.slug);
    const ok = await copyText(url);
    toast(ok ? '链接已复制' : '复制失败，请手动复制地址栏');
  }

  /* ---------- 事件总线 ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target;

    if (t.closest('[data-close]')) {
      const isExit = t.closest('[data-qzexit]');
      closeModal();
      if (isExit) qzExit();
      return;
    }

    // 图标优先级最高，点了只看详情，不触发外层卡片
    const aug = t.closest('[data-aug]');
    if (aug) {
      e.stopPropagation();
      return openAug(aug.dataset.aug);
    }
    const item = t.closest('[data-item]');
    if (item) {
      e.stopPropagation();
      return openItem(item.dataset.item);
    }

    if (t.closest('[data-qznext]')) return qzNext();
    if (t.closest('[data-qzagain]')) {
      closeModal();
      return openQuiz();
    }
    const qz = t.closest('[data-qz]');
    if (qz) return qzPick(Number(qz.dataset.qz));

    const jump = t.closest('[data-jump]');
    if (jump) {
      const sec = document.getElementById(jump.dataset.jump);
      if (sec) {
        const top = sec.getBoundingClientRect().top + window.scrollY - 116;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
      return;
    }

    const bst = t.closest('[data-build]');
    if (bst) {
      const n = Number(bst.dataset.build);
      if (n === S.build) return;
      S.build = n;
      S.augFilter = 'all';
      S.expand = {};
      renderBody();
      const body = $('#pageBody');
      if (body) {
        const top = body.getBoundingClientRect().top + window.scrollY - 64;
        if (window.scrollY > top) window.scrollTo({ top, behavior: 'smooth' });
      }
      return;
    }

    const af = t.closest('[data-afilter]');
    if (af) {
      S.augFilter = af.dataset.afilter;
      return renderBody();
    }

    const ex = t.closest('[data-expand]');
    if (ex) {
      const b = curBuild();
      if (b) S.expand[b.k] = ex.dataset.expand === '1';
      return renderBody();
    }

    const pl = t.closest('[data-plan]');
    if (pl) return openPlan(Number(pl.dataset.plan));

    const plm = t.closest('[data-planmore]');
    if (plm) {
      S.planAll = plm.dataset.planmore === '1';
      return renderBody();
    }

    if (t.closest('#favBtn')) return toggleFav(S.hero && S.hero.slug);
    if (t.closest('#shareBtn')) return shareHero();
    if (t.closest('#randomHero') || t.closest('[data-act="random"]')) return randomHero();
    if (t.closest('#openQuiz') || t.closest('[data-act="quiz"]')) return openQuiz();
  });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toUpperCase();
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA';
    if (e.key === 'Escape') {
      if ($('#modal').classList.contains('open')) {
        closeModal();
        qzExit();
      } else if (inInput) e.target.blur();
      else closeSide();
      return;
    }
    if (inInput) return;
    if (e.key === '/') {
      e.preventDefault();
      $('#q').focus();
    } else if (e.key.toLowerCase() === 'r') randomHero();
    else if (e.key.toLowerCase() === 'q') openQuiz();
    else if (/^[1-3]$/.test(e.key) && QZ.open) qzPick(Number(e.key) - 1);
    else if (e.key === ' ' && QZ.open && QZ.picked >= 0) {
      e.preventDefault();
      qzNext();
    }
  });

  /* 滚动时高亮顶部锚点 */
  let navTick = false;
  window.addEventListener(
    'scroll',
    () => {
      if (navTick) return;
      navTick = true;
      requestAnimationFrame(() => {
        navTick = false;
        const btns = $$('#quickNav .qn');
        if (!btns.length) return;
        let cur = btns[0];
        btns.forEach((b) => {
          const sec = document.getElementById(b.dataset.jump);
          if (sec && sec.getBoundingClientRect().top <= 150) cur = b;
        });
        btns.forEach((b) => b.classList.toggle('on', b === cur));
      });
    },
    { passive: true }
  );

  window.addEventListener('hashchange', () => {
    const slug = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (slug && (!S.hero || S.hero.slug !== slug)) openHero(slug);
  });

  window.__HD = { S, QZ, openHero, openAug, openItem, renderBody, renderList, openQuiz, qzPick, qzNext, closeModal };

  boot();
})();
