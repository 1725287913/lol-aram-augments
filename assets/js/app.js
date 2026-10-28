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

  // 锻体属性中文名
  const FORGE = {
    cd: '技能急速', 物穿: '护甲穿透', 法穿: '法术穿透', 攻击力: '攻击力', 攻速: '攻击速度',
    生命值: '生命值', 抗性: '双抗', 全能吸血: '全能吸血', 法强: '法术强度', 暴击: '暴击率', 移速: '移动速度',
  };

  const S = {
    index: [], augments: [], augMap: {}, itemMap: {}, heroMap: {}, plays: [],
    meta: {}, hero: null, rates: {},
    tab: 'play', playIdx: 0, tier: 'all', sort: 'wr', expand: false, view: 'hero',
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
    const [index, augments, items, meta, plays] = await Promise.all([
      getJSON(base + 'index.json'),
      getJSON(base + 'augments.json'),
      getJSON(base + 'items.json'),
      getJSON(base + 'meta.json'),
      getJSON(base + 'plays.json').catch(() => []),
    ]);
    S.index = index;
    S.augments = augments;
    S.meta = meta;
    S.plays = plays || [];
    augments.forEach((a) => (S.augMap[a.name] = a));
    items.forEach((i) => (S.itemMap[i.name] = i));
    index.forEach((h) => (S.heroMap[h.name] = h));

    const c = meta.counts || {};
    $('#patchInfo').innerHTML =
      `<b>${esc(meta.gamePatch || '')}</b> · ${c.heroes || index.length} 英雄 · ${c.augments || augments.length} 海克斯 · 更新 ${esc(meta.rateUpdatedAt || '')}`;
    $('#heroCount').textContent = index.length;
    if ($('#openPlays') && S.plays.length) $('#openPlays').textContent = `玩法库 ${S.plays.length}`;

    renderList();
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (hash) {
      const hit = S.index.find((h) => h.slug === hash || h.name === hash);
      if (hit) return openHero(hit.slug);
    }
    // 默认打开胜率最高且数据完整的英雄，避免空白
    openHero(S.index[0].slug);
  }

  /* ---------------- 英雄列表 ---------------- */
  let listTimer = null;
  function renderList(kw) {
    const q = (kw || '').trim().toLowerCase();
    const list = q
      ? S.index.filter(
          (h) =>
            h.name.toLowerCase().includes(q) ||
            h.slug.toLowerCase().includes(q) ||
            (h.aliases || []).some((a) => a.toLowerCase().includes(q))
        )
      : S.index;
    $('#heroCount').textContent = q ? `${list.length} / ${S.index.length}` : S.index.length;
    $('#heroGrid').innerHTML = list
      .map(
        (h) => `<div class="hcard${S.hero && S.hero.slug === h.slug ? ' active' : ''}" data-slug="${esc(h.slug)}" title="${esc(
          h.name + ' ' + (h.winRate != null ? h.winRate.toFixed(2) + '%' : '')
        )}">
        ${img(h.avatar, '', h.name)}
        <span class="wr">${h.winRate != null ? h.winRate.toFixed(1) : '—'}</span>
        <span class="nm">${esc(h.name)}</span>
      </div>`
      )
      .join('');
    if (!list.length) $('#heroGrid').innerHTML = `<div style="grid-column:1/-1;padding:24px 6px;color:#5e6b82;font-size:12px;text-align:center">没找到「${esc(q)}」</div>`;
  }

  $('#q').addEventListener('input', (e) => {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => renderList(e.target.value), 120);
  });

  $('#heroGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.hcard');
    if (card) openHero(card.dataset.slug);
  });

  /* ---------------- 打开英雄 ---------------- */
  async function openHero(slug) {
    if (S.hero && S.hero.slug === slug) return;
    $('#content').innerHTML = `<div style="padding:32px 24px"><div class="skel" style="height:110px;margin-bottom:16px"></div><div class="skel" style="height:260px"></div></div>`;
    try {
      const d = await getJSON(`data/heroes/${slug}.json`);
      S.hero = d;
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
    return `<div class="item" title="${esc(tip)}">${img(it.icon, '', it.name)}${
      idx ? `<span class="idx">${idx}</span>` : ''
    }</div>`;
  }

  function viewPlay() {
    const h = S.hero;
    const plays = h.playstyles || [];
    if (!plays.length) return `<div class="notice warn"><span class="ni">!</span><div>这个英雄暂无玩法数据。</div></div>`;
    const p = plays[S.playIdx] || plays[0];

    const forge = (p.forge || []).length
      ? `<div class="forge">${p.forge
          .map((f, i) => {
            const name = FORGE[f] || f;
            return `${i ? '<span class="forge-arrow">›</span>' : ''}<span class="forge-chip">${esc(name)}</span>`;
          })
          .join('')}</div>`
      : `<div class="notice" style="margin:0"><span class="ni">!</span><div>这一套暂无锻体数据，明日补充。</div></div>`;

    const combos = (h.augmentCombos || [])
      .map((c) => {
        const cells = c
          .map((n) => {
            const a = S.augMap[n];
            return `<div class="ci" title="${esc(n)}">${a ? img(a.icon, '', n) : '<span class="miss">?</span>'}</div>`;
          })
          .join('');
        return `<div class="combo" data-combo="${esc(c.join('|||'))}" title="${esc(c.join(' / '))}">${cells}<div class="cn">${esc(c.join(' · '))}</div></div>`;
      })
      .join('');

    return `
      <div class="section">
        <div class="sec-head"><h3>选择玩法</h3><div class="sec-line"></div><span class="hint">${plays.length} 套出装路线</span></div>
        <div class="play-tabs">
          ${plays
            .map(
              (x, i) =>
                `<button class="play-tab${i === S.playIdx ? ' on' : ''}" data-play="${i}">${esc(x.title || '玩法 ' + (i + 1))}</button>`
            )
            .join('')}
        </div>
      </div>

      <div class="section">
        <div class="sec-head"><h3>锻体</h3><div class="sec-line"></div><span class="hint">强化属性优先顺序</span></div>
        ${forge}
      </div>

      <div class="section">
        <div class="sec-head"><h3>出门装</h3><div class="sec-line"></div></div>
        <div class="items-row">${(p.startItems || []).map((i) => itemHTML(i)).join('') || '<span class="hint">—</span>'}</div>
      </div>

      <div class="section">
        <div class="sec-head"><h3>核心装备</h3><div class="sec-line"></div><span class="hint">按顺序出</span></div>
        <div class="items-row">${(p.coreItems || []).map((i, k) => itemHTML(i, k + 1)).join('') || '<span class="hint">—</span>'}</div>
      </div>

      ${
        (p.otherItems || []).length
          ? `<div class="section">
        <div class="sec-head"><h3>备选装备</h3><div class="sec-line"></div><span class="hint">看对面阵容换</span></div>
        <div class="items-row">${p.otherItems.map((i) => itemHTML(i)).join('')}</div>
      </div>`
          : ''
      }

      ${
        (p.shoes || []).length
          ? `<div class="section">
        <div class="sec-head"><h3>鞋子</h3><div class="sec-line"></div></div>
        <div class="shoes-row">${p.shoes.map((i) => itemHTML(i)).join('')}</div>
      </div>`
          : ''
      }

      ${
        (h.builds || []).length
          ? `<div class="section">
        <div class="sec-head"><h3>思路点评</h3><div class="sec-line"></div><span class="hint">来自攻略数据</span></div>
        ${h.builds
          .filter((b) => b.desc)
          .slice(0, 4)
          .map(
            (b) =>
              `<div class="chg"><div class="ver">${esc(b.tier || '')}</div><div class="tx"><b style="color:#e8ebf2">${esc(
                b.name
              )}</b><br>${esc(b.desc)}</div></div>`
          )
          .join('') || '<div class="notice" style="margin:0"><span class="ni">!</span><div>这套方案暂无文字点评。</div></div>'}
      </div>`
          : ''
      }

      ${
        combos
          ? `<div class="section">
        <div class="sec-head"><h3>强力海克斯组合</h3><div class="sec-line"></div><span class="hint">点任意一组看详情</span></div>
        <div class="combo-list">${combos}</div>
      </div>`
          : ''
      }
    `;
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
        <span class="hint">${S.plays.length} 套</span>
      </div>
      <div class="play-cards">
        ${S.plays
          .map(
            (p, i) => `<div class="pcard" data-play-open="${i}">
          <div class="pc-top">${p.augments
            .filter((a) => a.core)
            .map((a) => `<span class="pci">${a.icon ? img(a.icon, '', a.name) : '<span class="miss">?</span>'}</span>`)
            .join('')}</div>
          <div class="pc-name">${esc(p.name)}</div>
          <div class="pc-desc">${esc(p.description)}</div>
          <div class="pc-meta"><span>${p.combinations.length} 种出装</span><span class="pc-more">查看 ›</span></div>
        </div>`
          )
          .join('')}
      </div>
    `;
    $('.content').scrollTop = 0;
    window.scrollTo(0, 0);
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
    const rate = S.rates[name];
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  window.addEventListener('hashchange', () => {
    const slug = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (slug) openHero(slug);
  });

  // 调试句柄（控制台可直接调）
  window.__HD = { S, openHero, openAug, openPlay, showPlays, renderTab, renderList, closeModal };

  boot().catch((err) => {    document.body.innerHTML = `<div style="padding:40px;color:#e0645c;font-family:sans-serif">
      <h2>数据加载失败</h2><p style="color:#8b97ad;margin-top:8px">${esc(err.message)}</p>
      <p style="color:#5e6b82;margin-top:12px;font-size:13px">请用本地服务器打开（如 <code>python -m http.server</code>），直接双击 html 会被浏览器的同源策略拦住。</p>
    </div>`;
  });
})();
