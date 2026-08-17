const els = {
  content: document.getElementById('content'),
  provider: document.getElementById('provider'),
  updated: document.getElementById('updated'),
  refresh: document.getElementById('refresh'),
  banner: document.getElementById('banner'),
  onlySignals: document.getElementById('only-signals'),
  minEdge: document.getElementById('min-edge'),
  edgeValue: document.getElementById('edge-value'),
};

let payload = null;

const percent = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const signed = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

const MARKET_LABELS = {
  correctScore: 'матч',
  firstSetScore: '1-й сет',
};

function showBanner(text) {
  els.banner.textContent = text;
  els.banner.hidden = false;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderRow(row, isSignal) {
  const node = element('div', `row${isSignal ? ' row--signal' : ''}`);

  const label = element('div', 'row__score', row.outcome);
  label.append(element('span', 'row__market', MARKET_LABELS[row.market] ?? row.market));
  node.append(label);

  node.append(element('div', 'row__cell', percent(row.modelProb)));
  node.append(element('div', 'row__cell', row.marketOdds.toFixed(2)));

  const edge = element('div', `row__cell edge ${row.edge >= 0 ? 'edge--pos' : 'edge--neg'}`);
  edge.textContent = signed(row.edge);
  if (isSignal && row.stake > 0) {
    edge.append(element('span', 'stake', ` ${percent(row.stake, 1)} банка`));
  }
  node.append(edge);

  return node;
}

function renderCard(entry, { onlySignals, minEdge }) {
  const card = element('article', 'card');
  const head = element('div', 'card__head');

  const players = element('div', 'card__players');
  players.append(element('span', null, entry.match.players[0]));
  players.append(element('span', 'card__vs', '—'));
  players.append(element('span', null, entry.match.players[1]));
  head.append(players);

  const tags = element('div', 'card__tags');
  for (const tag of [entry.match.tournament, entry.match.surface, entry.match.tour?.toUpperCase()]) {
    if (tag) tags.append(element('span', null, tag));
  }
  head.append(tags);

  const bar = element('div', 'odds-bar');
  const fill = element('div', 'odds-bar__fill');
  fill.style.width = `${(entry.model.aWins * 100).toFixed(1)}%`;
  bar.append(fill);
  head.append(bar);

  const probs = element('div', 'card__probs');
  probs.append(element('span', null, percent(entry.model.aWins, 0)));
  probs.append(element('span', null, percent(1 - entry.model.aWins, 0)));
  head.append(probs);

  card.append(head);

  const visible = entry.markets
    .filter((row) => !onlySignals || row.edge >= minEdge)
    .sort((a, b) => b.edge - a.edge);

  if (visible.length === 0) {
    card.append(element('div', 'empty', 'Преимущества выше порога нет.'));
    return card;
  }

  const rows = element('div', 'rows');
  const header = element('div', 'row row__head');
  for (const title of ['исход', 'модель', 'кэф', 'преим.']) {
    header.append(element('div', title === 'исход' ? '' : 'row__cell', title));
  }
  rows.append(header);

  const signalKeys = new Set(entry.signals.map((s) => `${s.market}:${s.outcome}`));
  for (const row of visible) {
    rows.append(renderRow(row, signalKeys.has(`${row.market}:${row.outcome}`) && row.edge >= minEdge));
  }

  card.append(rows);
  return card;
}

function render() {
  if (!payload) return;

  const onlySignals = els.onlySignals.checked;
  const minEdge = Number(els.minEdge.value) / 100;
  els.edgeValue.textContent = `${els.minEdge.value}%`;

  els.provider.textContent = payload.provider;
  els.updated.textContent = payload.generatedAt
    ? `обновлено ${new Date(payload.generatedAt).toLocaleTimeString('ru-RU')}`
    : '';

  const cards = payload.matches
    .map((entry) => ({
      entry,
      best: Math.max(-1, ...entry.markets.map((m) => m.edge)),
    }))
    .filter(({ best }) => !onlySignals || best >= minEdge)
    .sort((a, b) => b.best - a.best)
    .map(({ entry }) => renderCard(entry, { onlySignals, minEdge }));

  els.content.replaceChildren(
    ...(cards.length
      ? cards
      : [element('p', 'muted content__placeholder', 'Нет матчей с преимуществом выше порога.')]),
  );
}

async function load({ force = false } = {}) {
  els.refresh.disabled = true;
  try {
    const res = await fetch(`/api/signals${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);

    payload = await res.json();
    localStorage.setItem('lastPayload', JSON.stringify(payload));
    els.banner.hidden = payload.provider !== 'mock';
    if (payload.provider === 'mock') {
      showBanner('Демо-данные. Для боевых котировок задай PROVIDER=api-tennis и ключ API.');
    }
    render();
  } catch (err) {
    const cached = localStorage.getItem('lastPayload');
    if (cached) {
      payload = JSON.parse(cached);
      render();
      showBanner(`Нет связи с сервером (${err.message}). Показаны последние загруженные данные.`);
    } else {
      els.content.replaceChildren(
        element('p', 'muted content__placeholder', `Не удалось загрузить: ${err.message}`),
      );
    }
  } finally {
    els.refresh.disabled = false;
  }
}

els.refresh.addEventListener('click', () => load({ force: true }));
els.onlySignals.addEventListener('change', render);
els.minEdge.addEventListener('input', render);

// Service worker работает только в защищённом контексте. По http на голый IP
// его не будет — офлайн и установка на экран станут недоступны, но само
// приложение продолжит работать.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service worker не зарегистрирован:', err);
  });
}

load();
