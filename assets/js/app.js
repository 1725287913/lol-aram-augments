/* 海斗指南 — 前端逻辑 */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (n) => (n == null ? '—' : n.toFixed(2) + '%');
  const img = (src, cls, alt) =>
    src
      ? `<img src="${esc(src)}" class="${cls || ''}" alt="${esc(alt || '')}" loading="lazy" onerror="this.style.visibility='hidden'">`
      : `<span class="${cls || ''} miss">?</span>`;

  // 本地存储（无 localStorage 时静默降级）
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

  // 底部轻提示
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
  }

  // 复制到剪贴板（带 execCommand 兜底）
  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
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

  // 评级 → 徽章样式
  const TIER_RANK = { SSS: 6, SS: 5, S: 4, A: 3, B: 2, C: 1 };
  function tierKey(t) {
    const s = String(t || '').toUpperCase();
    return /^(SSS|SS|S|A|B|C)$/.test(s) ? s.toLowerCase() : 'c';
  }
  const tierScore = (t) => TIER_RANK[String(t || '').toUpperCase()] || 0;
  function rankBadge(t) {
    if (!t) return '';
    const k = tierKey(t);
    return `<span class="rank r-${k}" title="${esc(t)} 级方案"><span>${esc(t)}</span></span>`;
  }

  // 锻体属性中文名
  const FORGE = {
    cd: '技能急速', 物穿: '护甲穿透', 法穿: '法术穿透', 攻击力: '攻击力', 攻速: '攻击速度',
    生命值: '生命值', 抗性: '双抗', 全能吸血: '全能吸血', 法强: '法术强度', 暴击: '暴击率', 移速: '移动速度',
  };

  // 本地收藏，兼容历史脏数据
  const savedFavs = LS.get('hd_favs', []);
  const initFavs = Array.isArray(savedFavs) ? savedFavs.filter((x) => typeof x === 'string') : [];

  const S = {
    index: [], augments: [], augMap: {}, itemMap: {}, heroMap: {}, plays: [],
    meta: {}, hero: null, rates: {}, sup: {}, mp: {},
    tab: 'play', sub: 'build', builds: [], playIdx: 0, tier: 'all', sort: 'wr', expand: false, view: 'hero',
    favs: initFavs, playQ: '',
  };

  const TABS = [
    { k: 'play', label: '推荐玩法' },
    { k: 'augments', label: '海克斯' },
    { k: 'skills', label: '技能' },
    { k: 'changes', label: '改动' },
  ];

  /* ---------------- 数据加载 ---------------- */
  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  async function boot() {
    const base = 'data/';
    const [index, augments, items, meta, plays, sup, mp] = await Promise.all([
      getJSON(base + 'index.json'),
      getJSON(base + 'augments.json'),
      getJSON(base + 'items.json'),
      getJSON(base + 'meta.json'),
      getJSON(base + 'plays.json').catch(() => []),
      getJSON(base + 'supplement.json').catch(() => ({})),
      getJSON(base + 'builds_mp.json').catch(() => ({})),
    ]);
    S.index = index;
    S.augments = augments;
    S.meta = meta;
    S.plays = plays || [];
    S.sup = sup || {};
    S.mp = mp || {};
    augments.forEach((a) => (S.augMap[a.name] = a));
    items.forEach((i) => (S.itemMap[i.name] = i));
    index.forEach((h) => (S.heroMap[h.name] = h));

    const c = meta.counts || {};
    $('#patchInfo').innerHTML =
      `<b>${esc(meta.gamePatch || '')}</b> · ${c.heroes || index.length} 英雄 · ${c.augments || augments.length} 海克斯 · 更新 ${esc(meta.rateUpdatedAt || '')}`;
    $('#heroCount').textContent = index.length;
    if ($('#openPlays') && S.plays.length) {
      const sp = $('#openPlays').querySelector('span');
      if (sp) sp.textContent = `玩法库 ${S.plays.length}`;
    }

    renderList();

    // 空闲时预热拼音表：中文打错字也能认出来（放前面，href 直达时也会预加载）
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 600));
    idle(() => ensurePY());

    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (hash) {
      const hit = S.index.find((h) => h.slug === hash || h.name === hash);
      if (hit) return openHero(hit.slug);
    }
    // 默认打开胜率最高且数据完整的英雄，避免空白
    openHero(S.index[0].slug);
  }

  /* ---------------- 搜索：中文 / 别名 / 拼音 / 首字母 / 容错 ---------------- */
  // 汉字 → 无声调拼音（data/pinyin.txt 懒加载，63KB，不拖慢首屏）
  let PY = null;
  let pyLoading = null;
  function loadPY() {
    if (pyLoading) return pyLoading;
    pyLoading = fetch('data/pinyin.txt?v=20261028')
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
  // 保证拼音表就绪；刚加载完如果搜索框还有字，就按最新关键词重跑一次
  function ensurePY() {
    if (PY) return Promise.resolve(PY);
    return loadPY().then((m) => {
      const v = $('#q').value;
      if (v && v.trim()) renderList(v);
      return m;
    });
  }

  // 编辑距离（长度差 >3 直接放弃，省算力）
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    if (Math.abs(m - n) > 3) return 99;
    let prev = [];
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  // 允许打错几个字：越长越宽容
  const typoLimit = (n) => (n >= 8 ? 3 : n >= 5 ? 2 : 1);
  const isCN = (s) => /[\u4e00-\u9fa5]/.test(s);

  // 单个英雄的匹配分：0 = 不匹配，越高越准
  function heroScore(h, kw, kwPy) {
    let best = 0;
    for (const raw of [h.name, h.slug].concat(h.aliases || [])) {
      const n = String(raw).toLowerCase();
      if (n === kw) best = Math.max(best, 100);
      else if (n.indexOf(kw) === 0) best = Math.max(best, 92);
      else if (n.includes(kw)) best = Math.max(best, 84);
      // 中文输错一个字（非同音的情况，同音交给拼音比对）；两字名差别太大就不算
      else if (kw.length >= 3 && isCN(kw) && lev(n, kw) <= 1) best = Math.max(best, 56);
    }
    // 拼音比对：中文查询先转成拼音（剪辑 → jianji → 剑姬）
    const pq = kwPy && /[a-z]/.test(kwPy) ? kwPy : /[a-z]/.test(kw) ? kw : '';
    if (pq) {
      for (const pair of h.py || []) {
        const full = pair[0], ini = pair[1];
        if (full === pq || ini === pq) best = Math.max(best, 96);
        else if (full.indexOf(pq) === 0 || ini.indexOf(pq) === 0) best = Math.max(best, 88);
        else if (pq.length >= 3 && (full.includes(pq) || ini.includes(pq))) best = Math.max(best, 74);
        else if (pq.length >= 2 && /^[a-z]+$/.test(pq)) {
          // 拼音打错字母：jainji → jianji、zdran → zhadanren
          const d = Math.min(lev(full, pq), lev(ini, pq));
          if (d <= typoLimit(pq.length)) best = Math.max(best, d === 1 ? 66 : 52);
        }
      }
    }
    return best;
  }

  function searchHeroes(q) {
    const kw = (q || '').trim().toLowerCase();
    if (!kw) return { list: S.index, best: 0, hits: [] };
    const kwPy = isCN(kw) ? pyOf(kw) : '';
    const hits = [];
    for (const h of S.index) {
      const s = heroScore(h, kw, kwPy);
      if (s) hits.push({ h, s });
    }
    hits.sort((a, b) => b.s - a.s || (b.h.winRate || 0) - (a.h.winRate || 0));
    const best = hits.length ? hits[0].s : 0;
    // 已经有精确命中了，就别把 50 分的瞎猜混进列表
    const cut = best >= 88 ? best - 30 : 0;
    return { list: hits.filter((x) => x.s >= cut).map((x) => x.h), best, hits };
  }

  /* ---------------- 英雄列表 ---------------- */
  let listTimer = null;
  function heroCard(h, isFav) {
    return `<div class="hcard${S.hero && S.hero.slug === h.slug ? ' active' : ''}${isFav ? ' fav' : ''}" data-slug="${esc(
      h.slug
    )}" title="${esc(h.name + ' ' + (h.winRate != null ? h.winRate.toFixed(2) + '%' : ''))}">
        ${img(h.avatar, '', h.name)}
        ${h.winRate != null ? `<span class="wr">${h.winRate.toFixed(1)}</span>` : ''}
        <span class="star" data-fav="${esc(h.slug)}" title="收藏 / 取消收藏">★</span>
        <span class="nm">${esc(h.name)}</span>
      </div>`;
  }

  function renderList(kw) {
    const q = (kw || '').trim();
    const found = q ? searchHeroes(q) : { list: S.index, best: 0 };
    const list = found.list;
    $('#heroCount').textContent = q ? `${list.length} / ${S.index.length}` : S.index.length;

    const favSet = new Set(S.favs);
    const favHeroes = S.favs.map((s) => S.heroMap[s]).filter(Boolean);
    let html = '';
    // 搜索时不做分组，避免结果被收藏截断
    if (!q && favHeroes.length) {
      html += `<div class="grid-label">我的收藏 ${favHeroes.length}</div>`;
      html += favHeroes.map((h) => heroCard(h, true)).join('');
      html += `<div class="grid-label">全部英雄 ${S.index.length}</div>`;
    }
    // 靠拼音 / 容错匹配出来的，标一下免得以为搜错了
    if (q && list.length && found.best < 80) {
      html += `<div class="grid-label">拼音 / 近似匹配 · ${list.length} 个</div>`;
    } else if (q && list.length) {
      const top = list[0];
      const direct = [top.name, top.slug].concat(top.aliases || []).some((n) => String(n).toLowerCase().includes(q.toLowerCase()));
      if (!direct) html += `<div class="grid-label">按拼音匹配 · ${list.length} 个</div>`;
    }
    html += list.map((h) => heroCard(h, favSet.has(h.slug))).join('');
    if (!list.length) {
      html = `<div class="empty-hit">
        <b>没找到「${esc(q)}」</b>
        <span>试试拼音：<i>zdr</i> 炸弹人、<i>jj</i> 剑姬、<i>ys</i> 亚索</span>
        <span>打错字也认得，比如 <i>剪辑</i> → 无双剑姬，<i>jainji</i> 也能搜到</span>
      </div>`;
    }
    $('#heroGrid').innerHTML = html;
  }

  $('#q').addEventListener('input', (e) => {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => renderList(e.target.value), 120);
    if (!PY) ensurePY(); // 中文容错要等拼音表
  });

  $('#heroGrid').addEventListener('click', (e) => {
    // 点星标只收藏，不切英雄
    const star = e.target.closest('[data-fav]');
    if (star) {
      e.stopPropagation();
      toggleFav(star.dataset.fav);
      return;
    }
    const card = e.target.closest('.hcard');
    if (card) openHero(card.dataset.slug);
  });

  // 收藏 / 取消收藏
  function toggleFav(slug) {
    if (!slug) return;
    const i = S.favs.indexOf(slug);
    if (i >= 0) S.favs.splice(i, 1);
    else S.favs.unshift(slug);
    LS.set('hd_favs', S.favs);
    paintFavBtn();
    renderList($('#q').value);
    toast(i >= 0 ? '已取消收藏' : '已加入收藏，侧栏置顶');
  }

  // 只更新顶部收藏按钮，不重渲染整页（保留滚动位置）
  function paintFavBtn() {
    const btn = $('#favBtn');
    if (!btn || !S.hero) return;
    const on = S.favs.includes(S.hero.slug);
    btn.classList.toggle('on', on);
    const label = btn.querySelector('span');
    if (label) label.textContent = on ? '已收藏' : '收藏';
  }

  /* ---------------- 打开英雄 ---------------- */
  let heroSeq = 0; // 防止连点随机时旧请求覆盖新英雄
  // 方案数据：优先用小程序全量方案（data/builds_mp.json），再用人工补录覆盖个别字段
  function applySup(h) {
    const mp = S.mp && S.mp[h.slug];
    if (mp && mp.length) {
      h.builds = mp.map((b) => Object.assign({}, b, { hasDetail: (b.items || []).length > 0 }));
    }
    const sup = S.sup && (S.sup[h.slug] || S.sup[h.name]);
    if (!sup || !sup.builds) return;
    const aug = (n) => {
      const a = S.augMap[n];
      return { name: n, icon: a ? a.icon : null, tier: a ? a.tier : null, winRate: a && a.winRate != null ? a.winRate : null };
    };
    const item = (n) => {
      const i = S.itemMap[n];
      return { name: n, icon: i ? i.icon : null };
    };
    h.builds = h.builds || [];
    Object.entries(sup.builds).forEach(([name, p]) => {
      let b = h.builds.find((x) => x.name === name);
      if (!b) {
        b = { name, tier: null, desc: null, forge: [], coreAugments: [], altAugments: [], items: [], startItems: [], shoes: [], otherItems: [], hasDetail: false };
        h.builds.push(b);
      }
      if (p.tier) b.tier = p.tier;
      if (p.desc != null) b.desc = p.desc;
      if (p.tips) b.tips = p.tips;
      if (p.forge) b.forge = p.forge;
      if (p.coreAugments) b.coreAugments = p.coreAugments.map(aug);
      if (p.altAugments) b.altAugments = p.altAugments.map(aug);
      if (p.items) {
        b.items = p.items.map(item);
        b.hasDetail = true;
      }
    });
  }

  async function openHero(slug) {
    QZ.on = false;
    if (S.hero && S.hero.slug === slug) {
      // 从训练 / 玩法库回到同一个英雄时，内容区需要重绘一次
      if (S.view !== 'hero') {
        S.view = 'hero';
        renderHero();
        $('#content').scrollTop = 0;
      }
      return;
    }
    const seq = ++heroSeq;
    $('#content').innerHTML = `<div style="padding:32px 24px"><div class="skel" style="height:110px;margin-bottom:16px"></div><div class="skel" style="height:260px"></div></div>`;
    try {
      const d = await getJSON(`data/heroes/${slug}.json`);
      if (seq !== heroSeq) return;
      S.hero = d;
      applySup(d);
      S.view = 'hero';
      S.tab = 'play';
      S.playIdx = 0;
      S.tier = 'all';
      S.sort = 'wr';
      S.expand = false;
      S.rates = {};
      (d.recommendAugments || []).forEach((r) => (S.rates[r.name] = r));
      history.replaceState(null, '', '#' + encodeURIComponent(slug));
      renderHero();
      renderList($('#q').value);
      $('.content').scrollTop = 0;
      window.scrollTo(0, 0);
    } catch (err) {
      if (seq !== heroSeq) return;
      $('#content').innerHTML = `<div class="notice warn" style="margin:24px"><span class="ni">!</span><div>加载失败：${esc(err.message)}</div></div>`;
    }
  }

  /* ---------------- 英雄头部 ---------------- */
  function renderHero() {
    const h = S.hero;
    const delta =
      h.winRateChange != null && h.winRateChange !== 0
        ? `<span class="delta ${h.winRateChange > 0 ? 'up' : 'down'}">${h.winRateChange > 0 ? '+' : ''}${h.winRateChange.toFixed(2)}%</span>`
        : '';
    const buffs = (h.buff || [])
      .map(
        (b) =>
          `<span class="buff ${b.isBuff ? 'up' : 'down'}">${esc(b.label)} ${esc(b.value)}</span>`
      )
      .join('');
    const excl = (h.exclusiveChanges || [])
      .map((c) => `<span class="buff up">${esc(c.label || '专属')} ${esc(c.value || '')}</span>`)
      .join('');

    $('#content').innerHTML = `
      <div class="hero-head">
        <div class="splash" style="${h.splash ? `background-image:url('${esc(h.splash)}')` : ''}"></div>
        <div class="hero-top">
          ${img(h.avatar, 'hero-avatar', h.name)}
          <div class="hero-id">
            <div class="hero-name">
              <h1>${esc(h.name)}</h1>
              ${(h.aliases || []).length ? `<span class="alias">${esc(h.aliases.slice(0, 3).join(' / '))}</span>` : ''}
            </div>
            <div class="hero-stat">
              ${h.winRate != null ? `<div class="stat-wr"><b>${h.winRate.toFixed(2)}%</b><span>胜率</span>${delta}</div>` : ''}
              ${(h.spells || []).length ? `<div class="buffs" style="margin:0">${h.spells.map((s) => `<span class="item" style="width:26px;height:26px;cursor:default">${img(s)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="tags">${(h.positions || []).slice(0, 8).map((p) => `<span class="tag">${esc(p)}</span>`).join('')}${
              (h.positions || []).length > 8 ? `<span class="tag" title="${esc(h.positions.slice(8).join(' / '))}">+${h.positions.length - 8}</span>` : ''
            }</div>
            ${buffs || excl ? `<div class="buffs">${buffs}${excl}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="tabs">
        ${TABS.map((t) => `<button class="tab${S.tab === t.k ? ' on' : ''}" data-tab="${t.k}">${t.label}${
          t.k === 'augments' ? `<span class="badge">${(h.recommendAugments || []).length}</span>` : ''
        }</button>`).join('')}
        <div class="tab-acts">
          <button class="act${S.favs.includes(h.slug) ? ' on' : ''}" id="favBtn" title="收藏后置顶在左侧列表">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.6l2.9 6.2 6.8.9-5 4.7 1.3 6.7-6-3.3-6 3.3 1.3-6.7-5-4.7 6.8-.9z"/></svg>
            <span>${S.favs.includes(h.slug) ? '已收藏' : '收藏'}</span>
          </button>
          <button class="act" id="shareBtn" title="复制这个英雄的直达链接">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.6 1.6"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.6-1.6"/></svg>
            <span>分享</span>
          </button>
        </div>
      </div>
      <div class="tab-body" id="tabBody"></div>
    `;
    renderTab();
  }

  function renderTab() {
    const box = $('#tabBody');
    if (!box) return;
    const map = { play: viewPlay, augments: viewAugments, skills: viewSkills, changes: viewChanges };
    box.innerHTML = (map[S.tab] || viewPlay)();
    box.style.animation = 'none';
    box.offsetHeight;
    box.style.animation = '';
    $('.tabs')
      .querySelectorAll('.tab')
      .forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  }

  /* ---------------- 推荐玩法 ---------------- */
  function itemHTML(it, idx) {
    if (!it) return '';
    const info = S.itemMap[it.name] || {};
    const tip = `${it.name}${info.price ? ' · ' + info.price + '金币' : ''}${info.desc ? '\n' + info.desc.replace(/<[^>]+>/g, '') : ''}`;
    return `<div class="item" data-item="${esc(it.name)}" title="${esc(tip)}">${img(it.icon, '', it.name)}${
      idx ? `<span class="idx">${idx}</span>` : ''
    }</div>`;
  }

  const AUG_CN = { prismatic: '棱彩', gold: '黄金', silver: '白银' };

  // 一张构建方案卡：锻体 + 核心/备选海克斯 + 六件装备
  function buildCard(b, i) {
    // 已下架的海克斯排后面（版本更新后官方删除的，玩家这一局抽不到）
    const off = (a) => !!(S.augMap[a.name] || {}).isDeleted;
    const sortOff = (list) => list.slice().sort((x, y) => off(x) - off(y));
    const cores = sortOff((b.coreAugments || []).filter((a) => a.name));
    const alts = sortOff((b.altAugments || []).filter((a) => a.name)).slice(0, 5);
    const items = b.items || [];
    const forge = (b.forge || []).length
      ? `<div class="bc-forge"><span>锻体</span>${b.forge.map((f) => esc(FORGE[f] || f)).join('<i>·</i>')}</div>`
      : '';
    // 图标 + 名字，点图标看海克斯详情
    const cell = (a, big) => {
      const full = S.augMap[a.name] || {};
      const isOff = !!full.isDeleted;
      return `<div class="bca${big ? ' big' : ''}${isOff ? ' off' : ''}" data-aug="${esc(a.name)}" title="${esc(a.name)}${
        isOff ? '（当前版本已下架）' : ''
      }${a.winRate != null ? ' · 胜率 ' + a.winRate.toFixed(2) + '%' : ''}"><div class="bca-ic">${
        a.icon || full.icon ? img(a.icon || full.icon, '', a.name) : `<b>${esc(a.name.slice(0, 2))}</b>`
      }</div><div class="bca-nm">${esc(a.name)}</div>${isOff ? '<i class="bca-off">已下架</i>' : ''}</div>`;
    };
    return `<article class="bcard" data-build="${i}">
      <div class="bc-hd">
        ${rankBadge(b.tier)}
        <h4 class="bc-tt">${esc(b.name)}</h4>
        <span class="bc-go" data-build="${i}">查看详情<i>›</i></span>
      </div>
      ${forge}
      ${
        cores.length || alts.length
          ? `<div class="bc-augs">
        ${cores.length ? `<div class="ba"><span class="ba-l">核心</span><div class="ba-w">${cores.map((a) => cell(a, 1)).join('')}</div></div>` : ''}
        ${alts.length ? `<div class="ba"><span class="ba-l">备选</span><div class="ba-w">${alts.map((a) => cell(a)).join('')}</div></div>` : ''}
      </div>`
          : ''
      }
      ${items.length ? `<div class="bc-items">${items.map((it, k) => itemHTML(it, k + 1)).join('')}</div>` : ''}
    </article>`;
  }

  // 方案详情弹层：点评 + 提示 + 核心/备选海克斯 + 推荐装备
  function openBuild(i) {
    const b = (S.builds || [])[i];
    if (!b) return;
    const augGrid = (list) =>
      list
        .map((a) => {
          const full = S.augMap[a.name] || {};
          const wr = a.winRate != null ? a.winRate : full.winRate;
          const tier = a.tier || full.tier || '';
          return `<div class="bd-row${full.isDeleted ? ' off' : ''}" data-aug="${esc(a.name)}">
            <div class="bd-ic">${a.icon || full.icon ? img(a.icon || full.icon, '', a.name) : '<span class="miss">?</span>'}</div>
            <div class="bd-tx">
              <div class="bd-nm">${esc(a.name)}${full.isDeleted ? '<span class="off-tag">已下架</span>' : ''}</div>
              <div class="bd-sub">${tier ? `<span class="tier ${esc(tier)}">${esc(AUG_CN[tier] || tier)}</span>` : ''}${
                wr != null ? `<span style="color:${wrColor(wr)}">${wr.toFixed(2)}%</span>` : ''
              }</div>
              ${a.reason ? `<div class="bd-rs">${esc(a.reason)}</div>` : ''}
            </div>
          </div>`;
        })
        .join('');
    const items = b.items || [];
    const forge = (b.forge || []).length
      ? `<div class="bd-forge"><span>锻体</span>${b.forge.map((f) => esc(FORGE[f] || f)).join('<i>·</i>')}</div>`
      : '';
    showModal(`
      <div class="bd-hd">
        ${rankBadge(b.tier)}
        <div class="bd-hdt">
          <h3>${esc(b.name)}</h3>
          ${b.isUser && b.author ? `<div class="bd-by">${esc(b.author)} 贡献</div>` : ''}
        </div>
        <button class="m-x" data-close>✕</button>
      </div>
      <div class="bd-body">
        ${b.desc ? `<p class="bd-desc">${esc(b.desc)}</p>` : ''}
        ${b.tips ? `<div class="bd-tip"><span class="bd-tip-i">💡</span><div>${esc(b.tips)}</div></div>` : ''}
        ${forge}
        ${
          (b.coreAugments || []).length
            ? `<h5 class="bd-h">核心海克斯</h5><div class="bd-grid">${augGrid(b.coreAugments)}</div>`
            : ''
        }
        ${
          (b.altAugments || []).length
            ? `<h5 class="bd-h">备选海克斯</h5><div class="bd-grid">${augGrid(b.altAugments)}</div>`
            : ''
        }
        ${
          items.length
            ? `<h5 class="bd-h">${b.hasDetail ? '核心装备' : '常规出装'}</h5><div class="bd-grid">${items
                .map((it) => {
                  const info = S.itemMap[it.name] || {};
                  return `<div class="bd-row" data-item="${esc(it.name)}">
                    <div class="bd-ic">${img(it.icon, '', it.name)}</div>
                    <div class="bd-tx"><div class="bd-nm">${esc(it.name)}</div><div class="bd-sub">${
                      info.price ? info.price + ' 金币' : ''
                    }</div></div>
                  </div>`;
                })
                .join('')}</div>`
            : ''
        }
      </div>`);
  }

  // 三件套组合：按三个海克斯在本英雄身上的胜率均值排序
  function combosHTML(h) {
    const rows = (h.augmentCombos || []).map((c) => {
      const rs = c.map((n) => (S.rates[n] ? S.rates[n].winRate : null));
      const known = rs.filter((x) => x != null);
      const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
      return { c, avg, known: known.length };
    });
    rows.sort((a, b) => (b.avg || 0) - (a.avg || 0));
    return rows
      .map(({ c, avg, known }, i) => {
        const cells = c
          .map((n) => {
            const a = S.augMap[n];
            return `<div class="ci" title="${esc(n)}">${a ? img(a.icon, '', n) : '<span class="miss">?</span>'}</div>`;
          })
          .join('');
        return `<div class="combo" data-combo="${esc(c.join('|||'))}" title="${esc(c.join(' / '))}">
          <div class="combo-hd">${cells}<span class="combo-rk">${i + 1}</span></div>
          <div class="cn">${esc(c.join(' · '))}</div>
          ${
            avg != null
              ? `<div class="combo-wr" style="color:${wrColor(avg)}">均胜率 ${avg.toFixed(2)}%${
                  known < 3 ? `<i>${known}/3 有数据</i>` : ''
                }</div>`
              : `<div class="combo-wr dim">暂无胜率数据</div>`
          }
        </div>`;
      })
      .join('');
  }

  // 一套出装路线：锻体 → 出门 → 核心 → 备选 → 鞋子
  function routeCard(p, idx) {
    const forge = (p.forge || []).length
      ? `<div class="forge">${p.forge
          .map((f, i) => `${i ? '<span class="forge-arrow">›</span>' : ''}<span class="forge-chip">${esc(FORGE[f] || f)}</span>`)
          .join('')}</div>`
      : `<div class="rc-none">这套暂无锻体顺序，直接按下面的核心装备出</div>`;
    return `<div class="route-card">
      <div class="rc-head"><span class="rc-idx">${idx + 1}</span><b>${esc(p.title || '方案 ' + (idx + 1))}</b></div>
      <div class="rc-lbl">锻体顺序</div>
      ${forge}
      <div class="rc-lbl">出门装</div>
      <div class="items-row">${(p.startItems || []).map((i) => itemHTML(i)).join('') || '<span class="hint">—</span>'}</div>
      <div class="rc-lbl">核心装备 <i>按顺序出</i></div>
      <div class="items-row">${(p.coreItems || []).map((i, k) => itemHTML(i, k + 1)).join('') || '<span class="hint">—</span>'}</div>
      ${
        (p.otherItems || []).length
          ? `<div class="rc-lbl">备选装备 <i>看对面阵容换</i></div>
      <div class="items-row">${p.otherItems.map((i) => itemHTML(i)).join('')}</div>`
          : ''
      }
      ${
        (p.shoes || []).length
          ? `<div class="rc-lbl">鞋子</div>
      <div class="items-row">${p.shoes.map((i) => itemHTML(i)).join('')}</div>`
          : ''
      }
    </div>`;
  }

  // 玩法页：构建方案 / 常规玩法 / 海克斯三件套
  function viewPlay() {
    const h = S.hero;
    const plays = h.playstyles || [];
    // 有装备或海克斯的方案才算数，纯名字的空壳不展示；内容多的排前面，再按评级
    const fill = (b) => ((b.coreAugments || []).length ? 1 : 0) + ((b.items || []).length ? 1 : 0);
    const builds = (h.builds || [])
      .filter((b) => (b.items || []).length || (b.coreAugments || []).length || (b.altAugments || []).length)
      .sort((a, b) => fill(b) - fill(a) || tierScore(b.tier) - tierScore(a.tier));
    S.builds = builds;
    const combos = h.augmentCombos || [];
    const total = builds.length + plays.length + combos.length;
    if (!total) return `<div class="notice warn"><span class="ni">!</span><div>这个英雄暂无玩法数据。</div></div>`;

    const segs = [
      ['build', '构建方案', builds.length],
      ['route', '常规玩法', plays.length],
      ['combo', '海克斯三件套', combos.length],
    ].filter((s) => s[2]);
    const sub = segs.some((s) => s[0] === S.sub) ? S.sub : segs[0][0];

    let body = '';
    if (sub === 'build') {
      body = `<div class="build-list">${builds.map((b, i) => buildCard(b, i)).join('')}</div>`;
    } else if (sub === 'route') {
      body = `<div class="route-list">${plays.map((x, i) => routeCard(x, i)).join('')}</div>`;
    } else {
      body = `<div class="combo-list">${combosHTML(h)}</div>`;
    }

    return `<div class="play-tabs">${segs
      .map((s) => `<button class="pt${s[0] === sub ? ' on' : ''}" data-sub="${s[0]}">${s[1]}<i>${s[2]}</i></button>`)
      .join('')}</div>
      <div class="play-body">${body}</div>`;
  }

  /* ---------------- 海克斯 ---------------- */
  // 核心 / 陷阱海克斯：原版人工标注，带「为什么适合这个英雄」的理由
  function augReasonRow(a, kind) {
    const rate = S.rates[a.name];
    return `<div class="a-row ${kind}" data-aug="${esc(a.name)}">
      <div class="a-ic">${a.icon ? img(a.icon, '', a.name) : '<span class="miss">?</span>'}</div>
      <div class="a-bd">
        <div class="a-t1">
          <span class="a-nm">${esc(a.name)}</span>
          ${a.tierLabel ? `<span class="tier ${esc(a.tier || '')}">${esc(a.tierLabel)}</span>` : ''}
          ${rate ? `<span class="a-wr" style="color:${wrColor(rate.winRate)}">${pct(rate.winRate)}</span>` : ''}
        </div>
        ${a.reason ? `<div class="a-rs">${esc(a.reason)}</div>` : ''}
      </div>
    </div>`;
  }

  function viewAugments() {
    const h = S.hero;
    const cores = h.specialAugments || [];
    const traps = h.trapAugments || [];
    let list = (h.recommendAugments || []).slice();

    const head = `
      ${
        cores.length
          ? `<div class="section">
        <div class="sec-head"><h3>核心海克斯</h3><div class="sec-line"></div><span class="hint">这个英雄的专属强推，点开看理由</span></div>
        <div class="a-list">${cores.map((a) => augReasonRow(a, 'core')).join('')}</div>
      </div>`
          : ''
      }
      ${
        traps.length
          ? `<div class="section">
        <div class="sec-head"><h3>陷阱海克斯</h3><div class="sec-line"></div><span class="hint">看着好但实测不行，看到别拿</span></div>
        <div class="a-list">${traps.map((a) => augReasonRow(a, 'trap')).join('')}</div>
      </div>`
          : ''
      }
    `;

    if (!list.length) {
      return head + `<div class="notice warn"><span class="ni">!</span><div>这个英雄暂无海克斯胜率数据。</div></div>`;
    }
    if (S.tier !== 'all') list = list.filter((a) => a.tier === S.tier);
    if (S.sort === 'pick') list.sort((a, b) => b.pickRate - a.pickRate);
    else list.sort((a, b) => b.winRate - a.winRate);

    const total = (h.recommendAugments || []).length;
    const shown = S.expand ? list.length : Math.min(list.length, 24);
    const cards = list.slice(0, shown).map(augCard).join('');

    return `${head}
      <div class="section">
      <div class="sec-head"><h3>胜率排行</h3><div class="sec-line"></div><span class="hint">共 ${total} 个有数据</span></div>
      <div class="aug-tools">
        <div class="chip-group">
          ${[
            ['all', '全部'],
            ['prismatic', '棱彩'],
            ['gold', '黄金'],
            ['silver', '白银'],
          ]
            .map(([k, l]) => `<button class="chip${S.tier === k ? ' on' : ''}" data-tier="${k}">${l}</button>`)
            .join('')}
        </div>
        <div class="chip-group">
          <button class="chip${S.sort === 'wr' ? ' on' : ''}" data-sort="wr">按胜率</button>
          <button class="chip${S.sort === 'pick' ? ' on' : ''}" data-sort="pick">按选取率</button>
        </div>
      </div>
      <div class="aug-grid">${cards}</div>
      ${
        list.length > 24
          ? `<div style="text-align:center;margin-top:16px"><button class="chip" id="expandBtn" style="border:1px solid var(--line);background:var(--surface-2);padding:7px 18px">${
              S.expand ? '收起' : `展开全部 ${list.length} 个`
            }</button></div>`
          : ''
      }
      </div>
    `;
  }

  function augCard(a) {
    const tierLbl = a.tierLabel || '';
    return `<div class="aug" data-tier="${esc(a.tier || '')}" data-aug="${esc(a.name)}">
      <div class="ic">${a.icon ? img(a.icon, '', a.name) : '<span class="miss">?</span>'}</div>
      <div class="bd">
        <div class="t1"><span class="nm">${esc(a.name)}</span>${
      tierLbl ? `<span class="tier ${esc(a.tier || '')}">${esc(tierLbl)}</span>` : ''
    }</div>
        <div class="ds">${esc(a.short || '')}</div>
        <div class="st">
          <span><i>胜率 </i><b style="color:${wrColor(a.winRate)}">${pct(a.winRate)}</b></span>
          <span><i>选取 </i><b style="color:#8b97ad">${pct(a.pickRate)}</b></span>
        </div>
      </div>
    </div>`;
  }

  function wrColor(w) {
    if (w == null) return '#8b97ad';
    if (w >= 55) return '#4ecb8f';
    if (w >= 52) return '#8fce9f';
    if (w <= 46) return '#e0645c';
    return '#c3ccdb';
  }

  /* ---------------- 技能 ---------------- */
  function viewSkills() {
    const h = S.hero;
    const skills = h.skills || [];
    const prio = (h.points && h.points.priority) || [];
    const order = (h.points && h.points.skillOrder) || null;
    return `
      ${skills
        .map(
          (s) => `<div class="skill">
        <div class="si">${s.icon ? img(s.icon, '', s.name) : `<span class="miss">${esc((s.label || '?').slice(0, 2))}</span>`}</div>
        <div style="flex:1;min-width:0">
          <div class="key">${esc(s.label || s.key || '')}</div>
          <div class="sn">${esc(s.name || '')}</div>
          <div class="sd">${esc(s.desc || '')}</div>
        </div>
      </div>`
        )
        .join('')}

      ${
        prio.length
          ? `<div class="section" style="margin-top:18px">
        <div class="sec-head"><h3>加点顺序</h3><div class="sec-line"></div><span class="hint">主 ${esc(prio[0])} › ${
              esc(prio[1] || '')
            } › ${esc(prio[2] || '')}</span></div>
        ${
          order
            ? `<div class="points-row">${Object.keys(order)
                .sort((a, b) => a - b)
                .map((lv) => `<div class="pt${order[lv] === 'R' ? ' R' : ''}${prio.includes(order[lv]) ? ' prio' : ''}" title="等级 ${lv}">${esc(order[lv])}</div>`)
                .join('')}</div>`
            : ''
        }
      </div>`
          : ''
      }
    `;
  }

  /* ---------------- 改动 ---------------- */
  function viewChanges() {
    const h = S.hero;
    const ch = h.changes || [];
    const bug = h.bugFixes || [];
    const excl = h.exclusiveChanges || [];
    return `
      ${
        excl.length
          ? `<div class="section">
        <div class="sec-head"><h3>本模式专属改动</h3><div class="sec-line"></div></div>
        ${excl.map((c) => `<div class="chg"><div class="ver">专属</div><div class="tx">${esc(c.text || c)}</div></div>`).join('')}
      </div>`
          : ''
      }
      <div class="section">
        <div class="sec-head"><h3>版本改动</h3><div class="sec-line"></div><span class="hint">${ch.length} 条</span></div>
        ${ch.map((c) => `<div class="chg"><div class="ver">${esc(c.version || '')}</div><div class="tx">${esc(c.text || '')}</div></div>`).join('') || '<div class="notice" style="margin:0"><span class="ni">!</span><div>暂无改动记录。</div></div>'}
      </div>
      ${
        bug.length
          ? `<div class="section">
        <div class="sec-head"><h3>Bug 修复</h3><div class="sec-line"></div></div>
        ${bug.map((c) => `<div class="chg bug"><div class="ver">${esc(c.version || '')}</div><div class="tx">${esc(c.text || '')}</div></div>`).join('')}
      </div>`
          : ''
      }
      ${
        (h.patchNotes || []).length
          ? `<div class="section">
        <div class="sec-head"><h3>官方改动原文</h3><div class="sec-line"></div><span class="hint">${h.patchNotes.length} 个版本</span></div>
        ${h.patchNotes
          .map(
            (n) => `<details class="pn"><summary><span class="pn-date">${esc(n.date || '')}</span><span class="pn-title">${esc(
              n.title || ''
            )}</span></summary><div class="pn-tx">${esc(n.text)}</div></details>`
          )
          .join('')}
      </div>`
          : ''
      }
    `;
  }

  /* ---------------- 玩法库 ---------------- */
  // 以一个核心海克斯为核心搭出来的整套打法（原版「通用搭配」板块）
  function chipAug(a, clickable) {
    return `<span class="pchip"${clickable ? ` data-aug="${esc(a.name)}" style="cursor:pointer"` : ''} title="${esc(
      a.name
    )}"><span class="pci">${a.icon ? img(a.icon, '', a.name) : '<span class="miss">?</span>'}</span><b>${esc(a.name)}</b></span>`;
  }
  function chipItem(i, clickable) {
    const info = S.itemMap[i.name] || {};
    const tip = `${i.name}${i.reason ? ' — ' + i.reason : info.desc ? ' — ' + info.desc.replace(/<[^>]+>/g, '') : ''}`;
    return `<span class="pchip" title="${esc(tip)}"><span class="pci">${i.icon ? img(i.icon, '', i.name) : '<span class="miss">?</span>'}</span><b>${esc(
      i.name
    )}</b></span>`;
  }

  function showPlays() {
    S.view = 'plays';
    $('#content').innerHTML = `
      <div class="view-bar">
        <button class="chip" id="backHero">‹ 返回英雄</button>
        <h2>海克斯玩法库</h2>
        <input id="playQ" class="play-q" type="search" placeholder="搜玩法 / 海克斯 / 英雄" value="${esc(S.playQ)}">
        <span class="hint" id="playCount">${S.plays.length} 套</span>
      </div>
      <div class="play-cards" id="playList">${playCardsHTML()}</div>
    `;
    $('.content').scrollTop = 0;
    window.scrollTo(0, 0);
  }

  // 玩法卡片列表（支持关键词过滤：玩法名 / 描述 / 海克斯 / 适配英雄）
  function playCardsHTML() {
    const kw = S.playQ.trim().toLowerCase();
    const list = !kw
      ? S.plays
      : S.plays.filter((p) =>
          [
            p.name,
            p.description || '',
            (p.augments || []).map((a) => a.name).join(' '),
            (p.combinations || [])
              .map((c) => (c.name || '') + ' ' + (c.items || []).map((i) => i.name).join(' ') + ' ' + (c.heroes || []).map((h) => h.name).join(' '))
              .join(' '),
          ]
            .join(' ')
            .toLowerCase()
            .includes(kw)
        );
    const cnt = $('#playCount');
    if (cnt) cnt.textContent = kw ? `${list.length} / ${S.plays.length} 套` : `${S.plays.length} 套`;
    if (!list.length) return `<div style="grid-column:1/-1;padding:30px;text-align:center;color:#5e6b82;font-size:12px">没有匹配「${esc(S.playQ)}」的玩法</div>`;
    return list
      .map(
        (p) => `<div class="pcard" data-play-name="${esc(p.name)}">
          <div class="pc-top">${(p.augments || [])
            .filter((a) => a.core)
            .map((a) => `<span class="pci">${a.icon ? img(a.icon, '', a.name) : '<span class="miss">?</span>'}</span>`)
            .join('')}</div>
          <div class="pc-name">${esc(p.name)}</div>
          <div class="pc-desc">${esc(p.description)}</div>
          <div class="pc-meta"><span>${(p.combinations || []).length} 种出装</span><span class="pc-more">查看 ›</span></div>
        </div>`
      )
      .join('');
  }

  function openPlay(name) {
    const p = S.plays.find((x) => x.name === name);
    if (!p) return;
    const core = p.augments.filter((a) => a.core);
    const others = p.augments.filter((a) => !a.core);

    const combos = p.combinations
      .map((c) => {
        const ci = c.items.filter((i) => i.core);
        const oi = c.items.filter((i) => !i.core);
        const reasons = c.items.filter((i) => i.reason);
        const augReasons = c.augments.filter((a) => a.reason);
        return `<div class="cblk">
          <div class="cb-name">${esc(c.name)}</div>
          ${c.description ? `<div class="cb-desc">${esc(c.description)}</div>` : ''}
          ${ci.length ? `<div class="cb-lbl">核心出装</div><div class="pchips">${ci.map((i) => chipItem(i)).join('')}</div>` : ''}
          ${oi.length ? `<div class="cb-lbl">备选 / 情境装</div><div class="pchips">${oi.map((i) => chipItem(i)).join('')}</div>` : ''}
          ${reasons.length ? `<div class="ln-list" style="margin-top:8px">${reasons
            .map((i) => `<div class="ln"><span class="dot" style="background:#4ecb8f"></span><div><b>${esc(i.name)}</b> — ${esc(i.reason)}</div></div>`)
            .join('')}</div>` : ''}
          ${c.augments.length ? `<div class="cb-lbl">配套海克斯</div><div class="pchips">${c.augments.map((a) => chipAug(a, true)).join('')}</div>` : ''}
          ${augReasons.length ? `<div class="ln-list" style="margin-top:8px">${augReasons
            .map((a) => `<div class="ln"><span class="dot" style="background:#56b8f0"></span><div><b>${esc(a.name)}</b> — ${esc(a.reason)}</div></div>`)
            .join('')}</div>` : ''}
          ${
            c.heroes.length
              ? `<div class="cb-lbl">适配英雄</div><div class="mini-heroes">${c.heroes
                  .map(
                    (h) => `<div class="mh"${h.slug ? ` data-go="${esc(h.slug)}"` : ''} title="${esc(h.name)}">
              ${h.avatar ? img(h.avatar, '', h.name) : '<span class="miss">?</span>'}<span>${esc(h.name)}</span></div>`
                  )
                  .join('')}</div>`
              : ''
          }
        </div>`;
      })
      .join('');

    showModal(`
      <div class="m-head">
        <div class="mic">${core[0] && core[0].icon ? img(core[0].icon, '', core[0].name) : '<span class="miss">◆</span>'}</div>
        <div class="m-body">
          <div class="m-title"><h2>${esc(p.name)}</h2></div>
          <div class="m-sub"><span>${p.combinations.length} 种出装路线</span>${p.lastUpdate ? `<span>更新 ${esc(p.lastUpdate)}</span>` : ''}</div>
        </div>
        <button class="m-x" data-close>✕</button>
      </div>
      <div class="m-cnt">
        ${p.description ? `<div class="blk key"><div class="lbl">玩法思路</div><div class="txt">${esc(p.description)}</div></div>` : ''}
        ${core.length ? `<div class="blk"><div class="lbl">核心海克斯</div><div class="pchips">${core.map((a) => chipAug(a, true)).join('')}</div></div>` : ''}
        ${core.some((a) => a.reason) ? `<div class="ln-list">${core
          .filter((a) => a.reason)
          .map((a) => `<div class="ln"><span class="dot" style="background:#56b8f0"></span><div><b>${esc(a.name)}</b> — ${esc(a.reason)}</div></div>`)
          .join('')}</div>` : ''}
        ${others.length ? `<div class="blk"><div class="lbl">可选海克斯</div><div class="pchips">${others.map((a) => chipAug(a, true)).join('')}</div></div>` : ''}
        ${combos || '<div class="notice"><span class="ni">!</span><div>这套玩法暂无出装数据。</div></div>'}
      </div>
    `);
  }


  function openAug(name) {
    const a = S.augMap[name];
    const rate = S.hero ? S.rates[name] : null;
    if (!a) {
      showModal(`<div class="m-head"><div class="mic"><span class="miss">?</span></div>
        <div class="m-body"><div class="m-title"><h2>${esc(name)}</h2></div>
        <div class="m-sub">这个词条暂无收录数据，明日补全</div></div></div>`);
      return;
    }

    // 小提示：人工 tips 优先，再补自动判断
    const tipLines = [];
    if (a.tips) tipLines.push(a.tips);
    const limits = (a.limit || []).filter((l) => l && l !== '垃圾');
    if (limits.length) tipLines.push(`适配：${limits.join('、')}`);
    if (rate) {
      if (rate.winRate >= 55) tipLines.push(`${S.hero.name}用这个胜率 ${rate.winRate.toFixed(2)}%，当前版本很强势，见到基本必拿。`);
      else if (rate.winRate <= 46) tipLines.push(`${S.hero.name}用这个胜率只有 ${rate.winRate.toFixed(2)}%，除非没得选，建议避开。`);
    }

    const good = [...(a.specialItems || []), ...(a.items || [])];
    const seen = new Set();
    const goodUniq = good.filter((g) => {
      const n = g.name || g;
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
    const trap = a.trapItems || [];

    const itemRow = (arr, tone) =>
      arr
        .map((g) => {
          const nm = g.name || g;
          const info = S.itemMap[nm] || {};
          return `<div class="ln"><span class="dot" style="background:${tone}"></span><div><b>${esc(nm)}</b>${
            g.reason ? ` — ${esc(g.reason)}` : info.desc ? ` — ${esc(info.desc.replace(/<[^>]+>/g, '').slice(0, 60))}` : ''
          }</div></div>`;
        })
        .join('');

    showModal(`
      <div class="m-head">
        <div class="mic">${a.icon ? img(a.icon, '', a.name) : '<span class="miss">?</span>'}</div>
        <div class="m-body">
          <div class="m-title">
            <h2>${esc(a.name)}</h2>
            ${a.tierLabel ? `<span class="tier ${esc(a.tier || '')}">${esc(a.tierLabel)}</span>` : ''}
          </div>
          <div class="m-sub">
            ${rate ? `<span>${esc(S.hero.name)} 胜率 <b style="color:${wrColor(rate.winRate)}">${pct(rate.winRate)}</b></span><span>选取 <b>${pct(rate.pickRate)}</b></span>` : '<span>本英雄暂无胜率数据</span>'}
            ${a.winRate != null ? `<span>全局 <b>${pct(a.winRate)}</b></span>` : ''}
          </div>
        </div>
        <button class="m-x" data-close>✕</button>
      </div>
      <div class="m-cnt">
        ${a.short ? `<div class="blk key"><div class="lbl">一句话</div><div class="txt">${esc(a.short)}</div></div>` : ''}
        ${a.desc ? `<div class="blk"><div class="lbl">完整效果</div><div class="txt">${esc(a.desc)}</div></div>` : ''}
        ${
          tipLines.length
            ? `<div class="blk tip"><div class="blk-lbl">小提示</div><div class="txt">${tipLines.map((t) => esc(t)).join('<br>')}</div></div>`
            : ''
        }
        ${goodUniq.length ? `<div class="blk"><div class="lbl">推荐装备</div>${itemRow(goodUniq, '#4ecb8f')}</div>` : ''}
        ${trap.length ? `<div class="blk"><div class="lbl" style="color:#e0645c">慎用装备</div>${itemRow(trap, '#e0645c')}</div>` : ''}
        ${
          (a.synergy || []).length
            ? `<div class="blk"><div class="lbl" style="color:#4ecb8f">搭配更猛</div><div class="ln-list">${a.synergy
                .map(
                  (s) =>
                    `<div class="ln" data-aug="${esc(s.name)}" style="cursor:pointer"><span class="dot" style="background:#4ecb8f"></span><div><b>${esc(
                      s.name
                    )}</b> — ${esc(s.text)}</div></div>`
                )
                .join('')}</div></div>`
            : ''
        }
        ${
          (a.conflict || []).length
            ? `<div class="blk"><div class="lbl" style="color:#e0645c">互相冲突</div><div class="ln-list">${a.conflict
                .map(
                  (s) =>
                    `<div class="ln" data-aug="${esc(s.name)}" style="cursor:pointer"><span class="dot" style="background:#e0645c"></span><div><b>${esc(
                      s.name
                    )}</b> — ${esc(s.text.replace(/^【避坑：?/, '').replace(/】$/, ''))}</div></div>`
                )
                .join('')}</div></div>`
            : ''
        }
        ${
          (a.plays || []).length
            ? `<div class="blk"><div class="lbl">相关玩法</div><div class="chip-line">${a.plays
                .map((n) => `<button class="chip play-link" data-play-name="${esc(n)}">${esc(n)} ›</button>`)
                .join('')}</div></div>`
            : ''
        }
        ${
          (a.changes || []).length
            ? `<div class="blk"><div class="lbl">改动</div>${a.changes
                .map((c) => `<div class="ln"><span class="dot"></span><div><b>${esc(c.version)}</b> ${esc(c.text)}</div></div>`)
                .join('')}</div>`
            : ''
        }
        ${(a.positions || []).filter(Boolean).length ? `<div class="blk"><div class="lbl">效果标签</div><div class="tags">${a.positions.filter(Boolean).map((p) => `<span class="tag">${esc(p)}</span>`).join('')}</div></div>` : ''}
        ${
          (a.bestHeroes || []).length
            ? `<div class="blk"><div class="lbl">用得最好的英雄</div><div class="mini-heroes">${a.bestHeroes
                .map((x) => {
                  const hh = S.heroMap[x.name];
                  return `<div class="mh" data-go="${esc(hh ? hh.slug : '')}" title="${esc(x.name)} · 胜率 ${pct(x.winRate)} · 选取 ${pct(x.pickRate)}">
                    ${hh ? img(hh.avatar, '', x.name) : '<span class="miss">?</span>'}
                    <span>${esc(x.name)}</span>
                    <b style="color:${wrColor(x.winRate)}">${x.winRate.toFixed(1)}</b>
                  </div>`;
                })
                .join('')}</div></div>`
            : ''
        }
      </div>
    `);
  }

  /* ---------------- 装备详情 ---------------- */
  function openItem(name) {
    const it = S.itemMap[name];
    if (!it) {
      toast('这件装备暂无数据');
      return;
    }
    const key = (g) => (typeof g === 'string' ? g : (g && g.name) || '');
    const hit = (arr) => (arr || []).some((g) => key(g) === name);
    // 哪些海克斯在推荐 / 慎用里提过这件装备
    const augs = S.augments.filter((a) => hit(a.items) || hit(a.specialItems) || hit(a.trapItems));
    // 哪些玩法库组合里用到它
    const inPlays = S.plays.filter((p) => (p.combinations || []).some((c) => (c.items || []).some((i) => i.name === name)));

    showModal(`
      <div class="m-head">
        <div class="mic">${it.icon ? img(it.icon, '', it.name) : '<span class="miss">?</span>'}</div>
        <div class="m-body">
          <div class="m-title"><h2>${esc(it.name)}</h2></div>
          <div class="m-sub">
            ${it.price != null ? `<span>售价 <b>${it.price}</b></span>` : ''}
            ${it.sellPrice != null ? `<span>回收 <b>${it.sellPrice}</b></span>` : ''}
            ${it.id ? `<span>编号 ${esc(it.id)}</span>` : ''}
          </div>
        </div>
        <button class="m-x" data-close>✕</button>
      </div>
      <div class="m-cnt">
        ${it.desc ? `<div class="blk"><div class="lbl">装备效果</div><div class="txt">${esc(it.desc)}</div></div>` : ''}
        ${
          augs.length
            ? `<div class="blk"><div class="lbl">提到它的海克斯</div><div class="chip-line">${augs
                .slice(0, 18)
                .map((a) => `<button class="chip play-link" data-aug="${esc(a.name)}">${esc(a.name)}</button>`)
                .join('')}</div></div>`
            : ''
        }
        ${
          inPlays.length
            ? `<div class="blk"><div class="lbl">出现在这些玩法</div><div class="chip-line">${inPlays
                .map((p) => `<button class="chip play-link" data-play-name="${esc(p.name)}">${esc(p.name)} ›</button>`)
                .join('')}</div></div>`
            : ''
        }
      </div>
    `);
  }

  /* ---------------- 海克斯三选一（选卡训练） ---------------- */
  const QZ_TIERS = ['prismatic', 'gold', 'silver'];
  const QZ_TIER_CN = { prismatic: '棱彩', gold: '黄金', silver: '白银' };
  const qzSaved = LS.get('hd_quiz', null);
  const QZ = {
    on: false, hero: null, rates: {}, base: 50,
    round: 0, options: [], picked: -1, scores: [], log: [],
    stat:
      qzSaved && typeof qzSaved === 'object'
        ? { n: qzSaved.n || 0, sum: qzSaved.sum || 0, best: qzSaved.best || 0 }
        : { n: 0, sum: 0, best: 0 },
  };

  // 该英雄各海克斯的真实胜率（来自数据里的英雄维度统计）
  function qzRates(h) {
    const m = {};
    (h.recommendAugments || []).forEach((r) => {
      if (r.winRate != null && r.winRate > 0) m[r.name] = { winRate: r.winRate, pickRate: r.pickRate };
    });
    return m;
  }

  // 某个海克斯在这个英雄身上的胜率；没有人物数据就退回全局胜率
  function qzRate(name) {
    const r = QZ.rates[name];
    if (r && r.winRate > 0) return r.winRate;
    const a = S.augMap[name];
    if (a && a.winRate > 0) return a.winRate;
    return QZ.base;
  }

  // 抽三张：只用该英雄有真实数据的，保证三张同口径；
  // 并按「三张拉得开但别太离谱」来挑组合——太接近选哪个都对，太悬殊一眼看穿
  function qzDraw(tier) {
    const inTier = S.augments.filter((a) => a.tier === tier && !a.isDeleted);
    const own = inTier.filter((a) => QZ.rates[a.name] && QZ.rates[a.name].winRate > 0);
    const pool = own.length >= 8 ? own : inTier.filter((a) => qzRate(a.name) > 0);
    if (pool.length <= 3) return pool.slice();
    const TARGET = 4.5;
    let best = null;
    for (let t = 0; t < 40; t++) {
      const bag = pool.slice();
      const pick = [];
      while (pick.length < 3 && bag.length) pick.push(bag.splice((Math.random() * bag.length) | 0, 1)[0]);
      if (pick.length < 3) break;
      const rs = pick.map((a) => qzRate(a.name));
      const spread = Math.max.apply(null, rs) - Math.min.apply(null, rs);
      const sc = -Math.abs(spread - TARGET) + pick.filter((a) => own.indexOf(a) >= 0).length * 0.5;
      if (!best || sc > best.sc) best = { pick, sc };
      if (Math.abs(spread - TARGET) < 0.5) break;
    }
    return best ? best.pick : pool.slice(0, 3);
  }

  async function openQuiz() {
    QZ.on = true;
    QZ.seq = (QZ.seq || 0) + 1;
    const my = QZ.seq;
    QZ.round = 0;
    QZ.scores = [];
    QZ.log = [];
    QZ.picked = -1;
    QZ.hero = null;
    S.view = 'quiz';
    const list = S.index.length ? S.index : [];
    if (!list.length) return;
    const pick = list[(Math.random() * list.length) | 0];
    $('#content').innerHTML = `<div class="qz-wrap"><div class="qz-loading">发牌中…</div></div>`;
    $('#content').scrollTop = 0;
    try {
      const h = await getJSON(`data/heroes/${pick.slug}.json`);
      if (!QZ.on || my !== QZ.seq) return;
      QZ.hero = h;
      QZ.rates = qzRates(h);
      QZ.base = h.winRate != null ? h.winRate : 50;
      qzDeal();
    } catch (e) {
      $('#content').innerHTML = `<div class="qz-wrap"><div class="notice warn"><span class="ni">!</span><div>发牌失败：${esc(
        e.message
      )}</div></div></div>`;
    }
  }

  function qzDeal() {
    QZ.picked = -1;
    const tier = QZ_TIERS[QZ.round];
    QZ.options = qzDraw(tier).map((a) => {
      const r = QZ.rates[a.name];
      return {
        name: a.name,
        icon: a.icon,
        tier,
        tierLabel: QZ_TIER_CN[tier],
        short: a.short || a.desc || '',
        rate: qzRate(a.name),
        pickRate: r ? r.pickRate : null,
        known: !!r,
      };
    });
    qzRender();
  }

  function qzRender() {
    const h = QZ.hero;
    if (!h) return;
    const done = QZ.picked >= 0;
    const ranked = QZ.options.map((o, i) => ({ o, i })).sort((a, b) => b.o.rate - a.o.rate);
    const bestRate = ranked[0] ? ranked[0].o.rate : 0;
    const secondRate = ranked[1] ? ranked[1].o.rate : bestRate;
    const bestIdx = ranked[0] ? ranked[0].i : -1;
    const mine = done ? QZ.options[QZ.picked] : null;
    const gap = done ? bestRate - mine.rate : 0;
    const score = done ? QZ.scores[QZ.round] : 0;

    const dots = QZ_TIERS.map(
      (t, i) =>
        `<span class="qz-dot${i < QZ.round ? ' done' : i === QZ.round ? ' now' : ''}">${
          i < QZ.round ? '✓ ' : ''
        }${QZ_TIER_CN[t]}</span>`
    ).join('');

    const cards = QZ.options
      .map((o, i) => {
        const isPick = done && i === QZ.picked;
        const isBest = done && i === bestIdx;
        const rkPos = ranked.findIndex((x) => x.i === i) + 1;
        const cls = ['qz-card'];
        if (done) cls.push('locked');
        if (isPick) cls.push('picked');
        if (isPick && gap > 0.05) cls.push('bad');
        if (isBest) cls.push('best');
        return `<div class="${cls.join(' ')}" data-qz-pick="${i}" data-tier="${o.tier}">
        <div class="qz-top"><span class="tier ${o.tier}">${o.tierLabel}</span>${
          done
            ? isBest
              ? `<span class="qz-rk gold">最优</span>`
              : `<span class="qz-rk">第 ${rkPos} 名</span>`
            : ''
        }</div>
        <div class="qz-ico">${img(o.icon, '', o.name)}</div>
        <div class="qz-name">${esc(o.name)}</div>
        <div class="qz-short">${esc(o.short)}</div>
        ${
          done
            ? `<div class="qz-stat"><b>${o.rate.toFixed(2)}%</b><span>${
                o.pickRate != null ? '选取 ' + o.pickRate.toFixed(1) + '%' : '全局数据'
              }</span></div>`
            : `<div class="qz-stat veil">选完揭晓胜率</div>`
        }
        </div>`;
      })
      .join('');

    let resHTML = '';
    if (done) {
      const hit = gap <= 0.05;
      const leadTxt =
        secondRate < bestRate - 0.05 ? `，领先第二 ${(bestRate - secondRate).toFixed(2)} 个点` : '';
      resHTML = `<div class="qz-res ${hit ? 'ok' : gap <= 1.5 ? 'mid' : 'bad'}">
        <div class="qz-res-l">
          <div class="qz-res-t">${
            hit ? '押中了最优解' : gap <= 1.5 ? '几乎最优，差一点点' : '这手选亏了'
          }</div>
          <div class="qz-res-s">${
            hit
              ? `数据上就是这张最强${leadTxt}。`
              : `数据最优是「${esc(QZ.options[bestIdx].name)}」${bestRate.toFixed(
                  2
                )}%，你选的「${esc(mine.name)}」${mine.rate.toFixed(2)}%，差 ${gap.toFixed(2)} 个点。`
          }</div>
        </div>
        <div class="qz-res-r">+${score}<span>分</span></div>
      </div>
      <button class="qz-next" data-qz-next>${
        QZ.round < 2 ? '下一轮 · ' + QZ_TIER_CN[QZ_TIERS[QZ.round + 1]] : '看总成绩'
      }</button>`;
    }

    const sc = $('#content').scrollTop;
    $('#content').innerHTML = `<div class="qz-wrap">
      <div class="qz-head">
        <button class="qz-exit" data-qz-exit>‹ 退出</button>
        <div class="qz-hero">
          ${img(h.avatar, '', h.name)}
          <div class="qz-hero-t"><b>${esc(h.name)}</b><span>整体胜率 ${
      h.winRate != null ? h.winRate.toFixed(2) + '%' : '—'
    }</span></div>
        </div>
        <div class="qz-prog">${dots}</div>
      </div>
      <div class="qz-tip">第 ${QZ.round + 1} 轮 · ${
      QZ_TIER_CN[QZ_TIERS[QZ.round]]
    }海克斯三选一，按这个英雄的真实胜率算分${done ? '' : '，选完才揭晓'}</div>
      <div class="qz-grid">${cards}</div>
      ${resHTML}
    </div>`;
    $('#content').scrollTop = sc;
  }

  function qzPick(i) {
    if (QZ.picked >= 0) return;
    const o = QZ.options[i];
    if (!o) return;
    QZ.picked = i;
    const bestRate = Math.max.apply(null, QZ.options.map((x) => x.rate));
    const bestIdx = QZ.options.findIndex((x) => x.rate === bestRate);
    const gap = Math.max(0, bestRate - o.rate);
    const score = Math.max(0, Math.round(100 - gap * 13));
    QZ.scores[QZ.round] = score;
    QZ.log[QZ.round] = {
      tier: o.tier,
      tierLabel: o.tierLabel,
      picked: o.name,
      pickedRate: o.rate,
      best: QZ.options[bestIdx] ? QZ.options[bestIdx].name : o.name,
      bestRate,
      gap,
      score,
    };
    qzRender();
  }

  function qzNext() {
    if (QZ.round < QZ_TIERS.length - 1) {
      QZ.round++;
      qzDeal();
      $('#content').scrollTop = 0;
    } else {
      qzFinish();
    }
  }

  // 段位：按一局三轮的平均分
  function qzRank(avg) {
    if (avg >= 97) return { key: 'king', name: '王者', note: '三轮全是数据最优，这判断可以直接开播了' };
    if (avg >= 92) return { key: 'master', name: '大师', note: '只有一手吃了亏，其他都押得死死的' };
    if (avg >= 85) return { key: 'dia', name: '钻石', note: '两轮押中，剩下一手也能选到次优' };
    if (avg >= 76) return { key: 'plat', name: '铂金', note: '大方向对，但偶尔会被「看着厉害」的骗' };
    if (avg >= 65) return { key: 'gold', name: '黄金', note: '基本靠感觉，跟数据还差着一截' };
    if (avg >= 50) return { key: 'silver', name: '白银', note: '被高选取率带偏了几次，选之前先想契合度' };
    return { key: 'bronze', name: '青铜', note: '先别跟风，开局前翻一眼这个英雄的胜率排行' };
  }

  function qzFinish() {
    const total = QZ.scores.reduce((a, b) => a + (b || 0), 0);
    const avg = total / QZ_TIERS.length;
    const rk = qzRank(avg);
    const st = QZ.stat;
    st.n = (st.n || 0) + 1;
    st.sum = (st.sum || 0) + total;
    st.best = Math.max(st.best || 0, total);
    LS.set('hd_quiz', st);

    const rows = QZ.log
      .map(
        (r) => `<div class="qz-log-row">
        <span class="tier ${r.tier}">${r.tierLabel}</span>
        <div class="qz-log-txt"><b>你选了「${esc(r.picked)}」</b><span>${
          r.gap <= 0.05
            ? '就是最优解'
            : `最优「${esc(r.best)}」${r.bestRate.toFixed(2)}%，差 ${r.gap.toFixed(2)} 个点`
        }</span></div>
        <span class="qz-log-sc">+${r.score}</span>
      </div>`
      )
      .join('');

    $('#content').innerHTML = `<div class="qz-wrap">
      <div class="qz-final">
        <div class="qz-final-top">
          <div class="qz-badge qz-${rk.key}"><span>${rk.name}</span></div>
          <div class="qz-total"><b>${total}</b><span>/ ${QZ_TIERS.length * 100}</span></div>
        </div>
        <div class="qz-final-note">${esc(rk.note)}</div>
        <div class="qz-sub">${esc(QZ.hero ? QZ.hero.name : '')} · 三轮复盘</div>
        <div class="qz-log">${rows}</div>
        <div class="qz-hist">已玩 ${st.n} 局 · 平均 ${st.n ? Math.round(st.sum / st.n) : 0} 分 · 最高 ${
      st.best
    } 分</div>
        <div class="qz-acts">
          <button class="qz-next" data-qz-again>再来一局</button>
          <button class="qz-exit wide" data-qz-hero>看这个英雄的攻略</button>
        </div>
      </div>
    </div>`;
    $('#content').scrollTop = 0;
  }

  function qzExit() {
    QZ.on = false;
    S.view = 'hero';
    if (S.hero) renderHero();
    else if (S.index.length) openHero(S.index[0].slug);
  }

  /* ---------------- 随机 / 分享 ---------------- */
  function randomHero() {
    if (!S.index.length) return;
    const cur = S.hero && S.hero.slug;
    let pick = cur;
    // 避免抽到当前这个（只剩一个英雄时除外）
    for (let i = 0; i < 8 && pick === cur && S.index.length > 1; i++) {
      pick = S.index[Math.floor(Math.random() * S.index.length)].slug;
    }
    const target = S.index.find((h) => h.slug === pick);
    if (!target) return;
    openHero(pick);
    toast(`随机到：${target.name}`);
  }

  function shareHero() {
    if (!S.hero) return;
    const url = location.href.split('#')[0] + '#' + encodeURIComponent(S.hero.slug);
    copyText(url).then((ok) => toast(ok ? '链接已复制，发群里就能直接打开' : '复制失败，请手动复制地址栏'));
  }

  function showModal(html) {
    const m = $('#modal');
    $('#modalCard').innerHTML = html;
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    const m = $('#modal');
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', (e) => {
    const t = e.target;

    if (t.closest('[data-close]')) return closeModal();

    // 顶栏：随机一个英雄 / 玩法库入口 / 三选一训练
    if (t.closest('#randomHero')) {
      randomHero();
      return;
    }
    if (t.closest('#openQuiz')) {
      if (!S.augments.length) return;
      openQuiz();
      return;
    }
    // 三选一训练：选牌 / 下一轮 / 再来一局 / 退出 / 看攻略
    const qzCard = t.closest('[data-qz-pick]');
    if (qzCard) {
      qzPick(+qzCard.dataset.qzPick);
      return;
    }
    if (t.closest('[data-qz-next]')) {
      qzNext();
      return;
    }
    if (t.closest('[data-qz-again]')) {
      openQuiz();
      return;
    }
    if (t.closest('[data-qz-exit]')) {
      qzExit();
      return;
    }
    if (t.closest('[data-qz-hero]')) {
      const slug = QZ.hero && QZ.hero.slug;
      QZ.on = false;
      if (slug) openHero(slug);
      return;
    }
    // 英雄页：收藏 / 分享
    if (t.closest('#favBtn')) {
      if (S.hero) toggleFav(S.hero.slug);
      return;
    }
    if (t.closest('#shareBtn')) {
      shareHero();
      return;
    }

    // 玩法库：入口 / 返回 / 打开某一套
    if (t.closest('#openPlays')) {
      if (!S.plays.length) return;
      showPlays();
      return;
    }
    if (t.closest('#backHero')) {
      S.view = 'hero';
      if (S.hero) renderHero();
      return;
    }
    const pc = t.closest('[data-play-open]');
    if (pc) {
      openPlay(S.plays[+pc.dataset.playOpen].name);
      return;
    }
    const plink = t.closest('[data-play-name]');
    if (plink) {
      closeModal();
      openPlay(plink.dataset.playName);
      return;
    }

    // 弹层里点小英雄卡 → 跳到那个英雄
    const go = t.closest('[data-go]');
    if (go && go.dataset.go) {
      closeModal();
      openHero(go.dataset.go);
      return;
    }

    const tab = t.closest('.tab');
    if (tab) {
      S.tab = tab.dataset.tab;
      S.expand = false;
      renderTab();
      return;
    }

    const pt = t.closest('.play-tab');
    if (pt) {
      S.playIdx = +pt.dataset.play;
      renderTab();
      return;
    }

    const chip = t.closest('.chip[data-tier]');
    if (chip) {
      S.tier = chip.dataset.tier;
      S.expand = false;
      renderTab();
      return;
    }
    const sortBtn = t.closest('.chip[data-sort]');
    if (sortBtn) {
      S.sort = sortBtn.dataset.sort;
      renderTab();
      return;
    }
    if (t.id === 'expandBtn') {
      S.expand = !S.expand;
      renderTab();
      return;
    }

    const aug = t.closest('[data-aug]');
    if (aug) return openAug(aug.dataset.aug);

    // 总览里的区块跳转
    const jump = t.closest('[data-jump]');
    if (jump) {
      const el = document.getElementById(jump.dataset.jump);
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    // 玩法页：切换构建方案 / 常规玩法 / 三件套
    const seg = t.closest('[data-sub]');
    if (seg) {
      S.sub = seg.dataset.sub;
      renderTab();
      return;
    }

    // 点装备图标看详情
    const itemEl = t.closest('[data-item]');
    if (itemEl) return openItem(itemEl.dataset.item);

    // 打开一套构建方案详情
    const bcardEl = t.closest('[data-build]');
    if (bcardEl) return openBuild(+bcardEl.dataset.build);

    // 组合卡：点图标看对应海克斯，点空白看第一件
    const combo = t.closest('[data-combo]');
    if (combo) {
      const names = combo.dataset.combo.split('|||');
      const ci = t.closest('.ci');
      const idx = ci ? [...combo.querySelectorAll('.ci')].indexOf(ci) : 0;
      openAug(names[idx] || names[0]);
      return;
    }
  });

  // 玩法库搜索（只换卡片，不重建整页，避免输入框丢焦点）
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'playQ') {
      S.playQ = e.target.value;
      const box = $('#playList');
      if (box) box.innerHTML = playCardsHTML();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (QZ.on) {
        qzExit();
        return;
      }
      closeModal();
      return;
    }
    // 搜索框里回车 = 直接打开最匹配的那个
    if (e.key === 'Enter' && e.target && e.target.id === 'q') {
      const v = (e.target.value || '').trim();
      if (v) {
        const r = searchHeroes(v);
        if (r.list.length) openHero(r.list[0].slug);
      }
      return;
    }
    const tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
    // 训练中：1/2/3 选牌，空格 / 回车下一轮
    if (QZ.on) {
      if (e.key >= '1' && e.key <= '3') {
        qzPick(+e.key - 1);
        return;
      }
      if ((e.key === ' ' || e.key === 'Enter') && QZ.picked >= 0) {
        e.preventDefault();
        qzNext();
      }
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      $('#q').focus();
    } else if (e.key === 'r' || e.key === 'R') {
      randomHero();
    } else if (e.key === 'q' || e.key === 'Q') {
      if (S.augments.length) openQuiz();
    }
  });

  window.addEventListener('hashchange', () => {
    const slug = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (slug) openHero(slug);
  });

  // 调试句柄（控制台可直接调）
  window.__HD = { S, QZ, openHero, openAug, openPlay, openItem, openBuild, showPlays, randomHero, shareHero, toggleFav, searchHeroes, renderTab, renderList, closeModal, openQuiz, qzPick, qzNext, qzFinish, qzExit };

  boot().catch((err) => {    document.body.innerHTML = `<div style="padding:40px;color:#e0645c;font-family:sans-serif">
      <h2>数据加载失败</h2><p style="color:#8b97ad;margin-top:8px">${esc(err.message)}</p>
      <p style="color:#5e6b82;margin-top:12px;font-size:13px">请用本地服务器打开（如 <code>python -m http.server</code>），直接双击 html 会被浏览器的同源策略拦住。</p>
    </div>`;
  });
})();
