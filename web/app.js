'use strict';

const view = document.getElementById('view');
const meta = document.getElementById('topbar-meta');
const state = { symbol: null, config: null };

/* ---------------- helpers ---------------- */

async function getJSON(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(v) {
  if (v === null || v === undefined) return '—';
  const n = Math.abs(v);
  if (n >= 1000) return v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  if (n >= 1) return String(+v.toFixed(4));
  return String(+v.toFixed(8));
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  if (diff < 60e3) return 'только что';
  const m = Math.floor(diff / 60e3);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.floor(h / 24)} д`;
}

function countdown(deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return 'закрывается';
  const h = Math.floor(left / 3600e3);
  const m = Math.floor((left % 3600e3) / 60e3);
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

const ticker = (s) => s.replace(/USDTM$/, '').replace(/^XBT$/, 'BTC');

/* ---------------- chart ---------------- */

function chartSVG(candles, opts) {
  const o = opts || {};
  // The viewBox is close to real CSS pixels and scales uniformly, so labels
  // keep their proportions. Level values live in the tiles below the chart —
  // here we only name the lines, which keeps the right gutter narrow.
  const W = 380, H = o.height || 200, padR = 34, padY = 12;
  if (!candles || candles.length < 2) return '';

  const view = candles.slice(-(o.window || 70));
  const plotW = W - padR;

  let lo = Infinity, hi = -Infinity;
  for (const c of view) { lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]); }
  for (const lvl of [o.entry, o.stop].concat(o.targets || [])) {
    if (typeof lvl === 'number') { lo = Math.min(lo, lvl); hi = Math.max(hi, lvl); }
  }
  if (o.zone) { lo = Math.min(lo, o.zone.bottom); hi = Math.max(hi, o.zone.top); }

  const span = (hi - lo) || 1;
  lo -= span * 0.06; hi += span * 0.06;
  const y = (p) => padY + (hi - p) / (hi - lo) * (H - padY * 2);
  const step = plotW / view.length;
  const bw = Math.max(1.6, step * 0.62);

  const parts = [];

  if (o.zone) {
    let start = view.findIndex((c) => c[0] >= o.zone.created_ts);
    if (start < 0) start = 0;
    const zx = start * step;
    const zTop = y(o.zone.top), zBot = y(o.zone.bottom);
    const colour = o.side === 'LONG' ? '#4a7dff' : '#f59e0b';
    parts.push(
      `<rect x="${zx.toFixed(1)}" y="${zTop.toFixed(1)}" width="${(plotW - zx).toFixed(1)}" ` +
      `height="${Math.max(1.5, zBot - zTop).toFixed(1)}" fill="${colour}" fill-opacity="0.16" ` +
      `stroke="${colour}" stroke-opacity="0.55" stroke-dasharray="3 3" stroke-width="1"/>`,
      `<text x="${(zx + 4).toFixed(1)}" y="${(zTop - 3).toFixed(1)}" fill="${colour}" ` +
      `font-size="9" font-weight="600">FVG</text>`
    );
  }

  view.forEach((c, i) => {
    const x = i * step + step / 2;
    const up = c[4] >= c[1];
    const colour = up ? '#26a17b' : '#e2504a';
    const top = y(Math.max(c[1], c[4]));
    const bot = y(Math.min(c[1], c[4]));
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${y(c[2]).toFixed(1)}" x2="${x.toFixed(1)}" ` +
      `y2="${y(c[3]).toFixed(1)}" stroke="${colour}" stroke-width="1"/>`,
      `<rect x="${(x - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" ` +
      `height="${Math.max(1, bot - top).toFixed(1)}" fill="${colour}"/>`
    );
  });

  // Levels can coincide — an exit exactly at target 2, say — so keep the line
  // but drop a label that would land on top of one already drawn.
  const labelled = [];
  const level = (price, colour, label, dash) => {
    if (typeof price !== 'number') return;
    const py = y(price);
    parts.push(
      `<line x1="0" y1="${py.toFixed(1)}" x2="${plotW}" y2="${py.toFixed(1)}" stroke="${colour}" ` +
      `stroke-width="1" stroke-opacity="0.8" stroke-dasharray="${dash}"/>`
    );
    if (labelled.some((used) => Math.abs(used - py) < 9)) return;
    labelled.push(py);
    parts.push(
      `<text x="${plotW + 4}" y="${(py + 3.2).toFixed(1)}" fill="${colour}" font-size="9.5">` +
      `${esc(label)}</text>`
    );
  };

  if (typeof o.exit === 'number') {
    level(o.exit, '#a78bfa', 'выход', '1 2');   // drawn first so it keeps its label
  }
  level(o.entry, '#f4f4f5', 'вход', '4 3');
  level(o.stop, '#e2504a', 'стоп', '2 3');
  (o.targets || []).forEach((t, i) => level(t, '#26a17b', `цель ${i + 1}`, '2 3'));

  // Plain market charts (no signal attached) carry neither — nothing to mark.
  if (typeof o.entry === 'number' && o.side) {
    const ex = plotW - step / 2;
    const ey = y(o.entry);
    const marker = o.side === 'LONG'
      ? `${ex},${ey - 9} ${ex - 6},${ey + 3} ${ex + 6},${ey + 3}`
      : `${ex},${ey + 9} ${ex - 6},${ey - 3} ${ex + 6},${ey - 3}`;
    parts.push(`<polygon points="${marker}" fill="${o.side === 'LONG' ? '#26a17b' : '#e2504a'}" ` +
      `stroke="#000" stroke-width="0.8"/>`);
  }

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="${esc(o.ariaLabel || 'График сигнала с зоной FVG, входом и выходом')}">` +
    `${parts.join('')}</svg>`;
}

function equitySVG(curve) {
  if (!curve || curve.length < 2) return '';
  const W = 380, H = 110, pad = 10;
  const values = curve.map((p) => p.r);
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = (hi - lo) || 1;
  const x = (i) => (i / (curve.length - 1)) * W;
  const y = (v) => pad + (hi - v) / span * (H - pad * 2);

  const line = curve.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.r).toFixed(1)}`).join('');
  const area = `${line}L${W},${y(lo).toFixed(1)}L0,${y(lo).toFixed(1)}Z`;
  const positive = values[values.length - 1] >= 0;
  const colour = positive ? '#26a17b' : '#e2504a';

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Кривая доходности">
    <line x1="0" y1="${y(0).toFixed(1)}" x2="${W}" y2="${y(0).toFixed(1)}" stroke="#2a2a30" stroke-width="1"/>
    <path d="${area}" fill="${colour}" fill-opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${colour}" stroke-width="1.8"/>
  </svg>`;
}

/* ---------------- cards ---------------- */

function strengthBlock(item) {
  return `<div class="strength">
    <div class="strength-row"><span>Сила сигнала</span><b>${Math.round(item.strength)}/100</b></div>
    <div class="bar"><i style="width:${Math.max(0, Math.min(100, item.strength))}%"></i></div>
  </div>`;
}

function levelsBlock(item) {
  const cells = [`<div class="level"><span>Вход</span><b>${fmt(item.entry)}</b></div>`];
  if (item.stop_loss != null) {
    const risk = Math.abs(item.entry - item.stop_loss) / item.entry * 100;
    cells.push(`<div class="level sl"><span>Стоп −${risk.toFixed(2)}%</span><b>${fmt(item.stop_loss)}</b></div>`);
  }
  (item.take_profits || []).forEach((tp, i) => {
    const gain = Math.abs(tp - item.entry) / item.entry * 100;
    cells.push(`<div class="level tp"><span>Цель ${i + 1} +${gain.toFixed(2)}%</span><b>${fmt(tp)}</b></div>`);
  });
  return `<div class="levels">${cells.join('')}</div>`;
}

function whyBlock(item, open) {
  const reasons = (item.reasons || []).map((r) => `<p class="reason">• ${esc(r)}</p>`).join('');
  const factors = (item.factors || []).map((f) => `
    <div class="factor">
      <div class="factor-row"><span>${esc(f.label)}</span><span>${f.score} / ${f.max}</span></div>
      <p class="factor-note">${esc(f.note)}</p>
      <div class="bar"><i style="width:${f.max ? (f.score / f.max * 100).toFixed(0) : 0}%"></i></div>
    </div>`).join('');
  return `<details class="why"${open ? ' open' : ''}>
    <summary>Почему такой сигнал</summary>${reasons}${factors}
  </details>`;
}

function statusBlock(item) {
  if (item.status === 'open') {
    const tps = item.tps_hit ? ` · взято целей: ${item.tps_hit}` : '';
    return `<div class="status"><span class="badge open">В сделке</span>
      <span>закроется через ${countdown(item.deadline)}${tps}</span></div>`;
  }
  if (!item.status) return '';

  const cls = item.status === 'win' ? 'win' : item.status === 'loss' ? 'loss' : '';
  const labels = { win: 'Профит', loss: 'Убыток', breakeven: 'Безубыток' };
  const exits = {
    sl: 'по стопу', be: 'стоп в безубытке', tp1: 'цель 1', tp2: 'цель 2',
    tp3: 'цель 3', timeout: 'по времени'
  };
  const r = item.r_multiple ?? 0;
  const sign = r >= 0 ? '+' : '';
  return `<div class="status"><span class="badge ${cls}">${labels[item.status] || item.status}</span>
    <span class="${cls}">${exits[item.exit_reason] || item.exit_reason || ''} —
    <b>${sign}${r.toFixed(2)}R</b> (${sign}${(item.pnl_pct ?? 0).toFixed(2)}%)</span></div>`;
}

function card(item, detailed) {
  const side = item.side.toLowerCase();
  const grade = (item.grade || 'd').toLowerCase();
  const body = `
    <div class="card-head">
      <div class="avatar ${side}">${esc(ticker(item.symbol))}</div>
      <div class="head-main">
        <div class="head-top">
          <span class="symbol">${esc(item.symbol)}</span>
          <span class="pill ${side}">${esc(item.side)}</span>
          <span class="dot">·</span>
          <span class="time">${timeAgo(item.created_at)}</span>
        </div>
        <div class="time">${esc(item.strategy)} · ${item.granularity}m</div>
      </div>
      <div class="grade ${grade}">${esc(item.grade || '—')}</div>
    </div>
    ${strengthBlock(item)}
    <div class="chart-wrap">${chartSVG(item.candles, {
      zone: item.zone, side: item.side, entry: item.entry, stop: item.stop_loss,
      targets: item.take_profits, exit: item.exit_price,
      height: detailed ? 280 : 200, window: detailed ? 100 : 60
    })}</div>
    ${levelsBlock(item)}
    ${whyBlock(item, detailed)}
    ${statusBlock(item)}`;

  return detailed
    ? `<article class="card">${body}</article>`
    : `<a class="card" href="#/signal/${item.id}">${body}</a>`;
}

/* ---------------- balance ---------------- */

function balanceBlock(b) {
  if (!b) return '';
  const tone = b.change_pct > 0 ? 'pos' : b.change_pct < 0 ? 'neg' : '';
  const sign = b.change_pct >= 0 ? '+' : '';
  return `
    <div class="section-title">Виртуальный баланс</div>
    <div class="balance-hero">
      <div class="balance-main">
        <b class="${tone}">${fmt(b.balance)} <span>${esc(b.currency)}</span></b>
        <span class="balance-change ${tone}">${sign}${b.change_pct}%</span>
      </div>
      <div class="balance-sub">
        Старт: ${fmt(b.starting_balance)} ${esc(b.currency)} · риск ${b.risk_per_trade_pct}% на сделку
        ${b.open_trades ? ` · в риске сейчас: ${fmt(b.at_risk)} ${esc(b.currency)} (${b.open_trades} сд.)` : ''}
      </div>
    </div>
    ${b.curve && b.curve.length > 1 ? `<div style="padding:10px 18px 0">${balanceCurveSVG(b.curve, b.currency)}</div>` : ''}
    <p class="disclaimer">Виртуальный расчёт: нет ни одного ключа биржи, деньгами бот не управляет. Это симуляция риска ${b.risk_per_trade_pct}% от текущего баланса на сделку.</p>`;
}

function balanceCurveSVG(curve, currency) {
  const W = 380, H = 110, pad = 10;
  const values = curve.map((p) => p.balance);
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = (hi - lo) || Math.max(1, values[0] * 0.02);
  const x = (i) => (i / (curve.length - 1)) * W;
  const y = (v) => pad + (hi - v) / span * (H - pad * 2);

  const line = curve.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join('');
  const area = `${line}L${W},${y(lo).toFixed(1)}L0,${y(lo).toFixed(1)}Z`;
  const positive = values[values.length - 1] >= values[0];
  const colour = positive ? '#26a17b' : '#e2504a';

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Кривая виртуального баланса в ${esc(currency)}">
    <path d="${area}" fill="${colour}" fill-opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${colour}" stroke-width="1.8"/>
  </svg>`;
}

/* ---------------- market ---------------- */

async function renderMarket() {
  try {
    const data = await getJSON('api/market');
    const items = data.items || [];

    if (!items.length) {
      view.innerHTML = `<div class="empty"><b>Пока нет данных</b>
        Рыночные свечи появятся после первого цикла опроса биржи.</div>`;
      meta.textContent = '';
      return;
    }

    const rows = items.map((m) => {
      const tone = m.change_pct > 0 ? 'pos' : m.change_pct < 0 ? 'neg' : '';
      const sign = m.change_pct >= 0 ? '+' : '';
      return `<a class="trow market-row" href="#/market/${esc(m.symbol)}">
        <span class="avatar ${tone === 'neg' ? 'short' : 'long'} market-avatar">${esc(ticker(m.symbol))}</span>
        <span class="name">${esc(m.symbol)}</span>
        <span class="cell">${fmt(m.last)}</span>
        <span class="cell ${tone}">${sign}${m.change_pct}%</span>
      </a>`;
    }).join('');

    view.innerHTML = `
      <div class="section-title">Рынок · ${data.granularity}m</div>
      <div class="table">${rows}</div>
      <p class="disclaimer">Изменение — за окно хранимых свечей, не за календарные сутки.</p>`;
    meta.textContent = `${items.length} пар · ${data.granularity}m`;
  } catch (err) {
    view.innerHTML = `<div class="empty"><b>Нет связи с сервером</b>${esc(err.message)}</div>`;
  }
}

async function renderMarketDetail(symbol) {
  try {
    const data = await getJSON(`api/market/${encodeURIComponent(symbol)}`);
    const candles = data.candles || [];
    const last = candles[candles.length - 1];
    const first = candles[0];
    const changePct = first && first[4] ? (last[4] - first[4]) / first[4] * 100 : 0;
    const tone = changePct > 0 ? 'pos' : changePct < 0 ? 'neg' : '';
    const sign = changePct >= 0 ? '+' : '';

    view.innerHTML = `<a class="backlink" href="#/market">← Рынок</a>
      <article class="card">
        <div class="card-head">
          <div class="avatar ${tone === 'neg' ? 'short' : 'long'}">${esc(ticker(data.symbol))}</div>
          <div class="head-main">
            <div class="head-top"><span class="symbol">${esc(data.symbol)}</span></div>
            <div class="time">${data.granularity}m · ${candles.length} свечей в окне</div>
          </div>
        </div>
        <div class="balance-hero" style="padding:0 0 12px">
          <div class="balance-main">
            <b>${fmt(last ? last[4] : null)}</b>
            <span class="balance-change ${tone}">${sign}${changePct.toFixed(2)}%</span>
          </div>
        </div>
        <div class="chart-wrap">${chartSVG(candles, { height: 280, window: 150, ariaLabel: `${data.symbol} рыночный график` })}</div>
      </article>
      <p class="disclaimer">Живой рыночный график, без привязки к сигналу.</p>`;
    meta.textContent = `${data.symbol} · ${data.granularity}m`;
  } catch (err) {
    view.innerHTML = `<a class="backlink" href="#/market">← Рынок</a>
      <div class="empty"><b>Нет данных по паре</b>${esc(err.message)}</div>`;
  }
}

/* ---------------- views ---------------- */

async function renderFeed() {
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (state.symbol) params.set('symbol', state.symbol);
    const data = await getJSON(`api/feed?${params}`);

    const chips = ['<button class="chip' + (state.symbol ? '' : ' active') + '" data-symbol="">Все</button>']
      .concat((data.symbols || []).map((s) =>
        `<button class="chip${state.symbol === s ? ' active' : ''}" data-symbol="${esc(s)}">${esc(ticker(s))}</button>`));

    if (!data.items.length) {
      view.innerHTML = `<div class="filters">${chips.join('')}</div>
        <div class="empty"><b>Пока пусто</b>Бот запущен и ждёт первый ретест FVG-зоны.
        Сигнал появится здесь и в Telegram-канале.</div>`;
    } else {
      view.innerHTML = `<div class="filters">${chips.join('')}</div>` +
        data.items.map((i) => card(i, false)).join('') +
        `<p class="disclaimer">Не является инвестиционной рекомендацией.</p>`;
    }

    view.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => { state.symbol = chip.dataset.symbol || null; renderFeed(); };
    });

    const open = data.items.filter((i) => i.status === 'open').length;
    meta.textContent = state.config
      ? `${state.config.strategy} · ${state.config.granularity}m · в сделке: ${open}`
      : `в сделке: ${open}`;
  } catch (err) {
    view.innerHTML = `<div class="empty"><b>Нет связи с сервером</b>${esc(err.message)}</div>`;
  }
}

async function renderDetail(id) {
  try {
    const item = await getJSON(`api/signals/${id}`);
    view.innerHTML = `<a class="backlink" href="#/">← Лента</a>${card(item, true)}
      <p class="disclaimer">Не является инвестиционной рекомендацией.</p>`;
    meta.textContent = `${item.symbol} · ${item.side}`;
  } catch (err) {
    view.innerHTML = `<a class="backlink" href="#/">← Лента</a>
      <div class="empty"><b>Сигнал не найден</b>${esc(err.message)}</div>`;
  }
}

function tile(label, value, tone) {
  const cls = tone === undefined ? '' : tone > 0 ? ' class="pos"' : tone < 0 ? ' class="neg"' : '';
  return `<div class="tile"><span>${esc(label)}</span><b${cls}>${esc(value)}</b></div>`;
}

function breakdown(title, groups, keyLabel) {
  const names = Object.keys(groups || {});
  if (!names.length) return '';
  const rows = names.map((name) => {
    const g = groups[name];
    const tone = g.total_r > 0 ? 'pos' : g.total_r < 0 ? 'neg' : '';
    return `<div class="trow">
      <span class="name">${esc(keyLabel ? keyLabel(name) : name)}</span>
      <span class="cell">${g.trades} сд.</span>
      <span class="cell">${g.winrate}%</span>
      <span class="cell ${tone}">${g.total_r > 0 ? '+' : ''}${g.total_r}R</span>
    </div>`;
  }).join('');
  return `<div class="section-title">${esc(title)}</div><div class="table">${rows}</div>`;
}

async function renderStats() {
  try {
    const s = await getJSON('api/stats');
    const o = s.overall;

    if (!o.trades) {
      view.innerHTML = `${balanceBlock(s.balance)}
        <div class="empty"><b>Статистики по сделкам пока нет</b>
        Она появится, когда закроется первая сделка.
        Сейчас в работе: ${o.open_now}.</div>`;
      meta.textContent = `в сделке: ${o.open_now}`;
      return;
    }

    view.innerHTML = `
      ${balanceBlock(s.balance)}
      <div class="section-title">Итого</div>
      <div class="tiles">
        ${tile('Сделок', o.trades)}
        ${tile('Винрейт', `${o.winrate}%`)}
        ${tile('Сумма R', `${o.total_r > 0 ? '+' : ''}${o.total_r}`, o.total_r)}
        ${tile('Средний R', `${o.avg_r > 0 ? '+' : ''}${o.avg_r}`, o.avg_r)}
        ${tile('Профит-фактор', o.profit_factor ?? '—')}
        ${tile('В сделке', o.open_now)}
        ${tile('Держим, ч', o.avg_hold_hours)}
        ${tile('Лучшая', `${o.best_r}R`, o.best_r)}
        ${tile('Худшая', `${o.worst_r}R`, o.worst_r)}
      </div>
      <div class="section-title">Кривая доходности, R</div>
      <div style="padding:0 18px">${equitySVG(s.equity_curve)}</div>
      ${breakdown('По парам', s.by_symbol, ticker)}
      ${breakdown('По направлению', s.by_side, (n) => (n === 'LONG' ? 'Лонг' : 'Шорт'))}
      ${breakdown('По силе сигнала', s.by_strength)}
      ${breakdown('По классу', s.by_grade)}
      <p class="disclaimer">R — прибыль в долях риска. Учитываются только закрытые сделки.</p>`;

    meta.textContent = `${o.trades} сделок · ${o.winrate}%`;
  } catch (err) {
    view.innerHTML = `<div class="empty"><b>Нет связи с сервером</b>${esc(err.message)}</div>`;
  }
}

/* ---------------- router ---------------- */

function route() {
  const hash = location.hash || '#/';
  const detail = hash.match(/^#\/signal\/(\d+)$/);
  const marketDetail = hash.match(/^#\/market\/(.+)$/);

  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  const active = hash.startsWith('#/stats') ? 'stats' : hash.startsWith('#/market') ? 'market' : 'feed';
  const tab = document.querySelector(`.tab[data-tab="${active}"]`);
  if (tab) tab.classList.add('active');

  window.scrollTo(0, 0);
  if (detail) return renderDetail(detail[1]);
  if (marketDetail) return renderMarketDetail(decodeURIComponent(marketDetail[1]));
  if (hash.startsWith('#/market')) return renderMarket();
  if (hash.startsWith('#/stats')) return renderStats();
  return renderFeed();
}

window.addEventListener('hashchange', route);

getJSON('api/config')
  .then((c) => { state.config = c; })
  .catch(() => {})
  .finally(route);

setInterval(() => {
  if (!document.hidden && !location.hash.startsWith('#/signal/')) route();
}, 60000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
