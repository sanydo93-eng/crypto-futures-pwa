const els = {
  content: document.getElementById('content'),
  provider: document.getElementById('provider'),
  updated: document.getElementById('updated'),
  refresh: document.getElementById('refresh'),
  banner: document.getElementById('banner'),
  filters: document.getElementById('filters'),
  statsControls: document.getElementById('stats-controls'),
  statsSearch: document.getElementById('stats-search'),
  onlySignals: document.getElementById('only-signals'),
  minEdge: document.getElementById('min-edge'),
  edgeValue: document.getElementById('edge-value'),
  footNote: document.getElementById('foot-note'),
  tabs: [...document.querySelectorAll('.tab')],
  statsSports: [...document.querySelectorAll('[data-stats-sport]')],
};

const state = {
  tab: 'tennis',
  statsSport: 'tennis',
  signals: { tennis: null, football: null },
  stats: { tennis: null, football: null },
};

const percent = (value, digits = 1) =>
  value == null ? '—' : `${(value * 100).toFixed(digits)}%`;
const signed = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
const decimal = (value, digits = 2) => (value == null ? '—' : value.toFixed(digits));

const FOOT_NOTES = {
  tennis: 'Точный счёт считается цепью Маркова по очкам: из вероятности выиграть очко '
    + 'на подаче выводится распределение по геймам, сетам и матчу.',
  football: 'Первый тайм считается пуассоновской моделью с поправкой Диксона — Коулза '
    + 'по собственным данным первых таймов, а не как доля от матча.',
  stats: 'Это входные данные моделей. У игроков и команд с малой выборкой оценка '
    + 'стягивается к среднему по туру или лиге — иначе редкие матчи дают ложные сигналы.',
};

const MARKET_LABELS = {
  correctScore: 'матч',
  firstSetScore: '1-й сет',
  firstHalfGoal: 'гол в 1Т',
  firstHalfTotal15: 'тотал 1Т',
  firstHalfResult: 'исход 1Т',
  firstHalfScore: 'счёт 1Т',
};

const OUTCOME_LABELS = {
  yes: 'да',
  no: 'нет',
  over: 'ТБ 1.5',
  under: 'ТМ 1.5',
  1: 'хозяева',
  X: 'ничья',
  2: 'гости',
};

const outcomeLabel = (market, outcome) =>
  market === 'firstHalfResult' || market === 'firstHalfGoal' || market === 'firstHalfTotal15'
    ? OUTCOME_LABELS[outcome] ?? outcome
    : outcome;

/* ---------- вспомогательное ---------- */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showBanner(text) {
  if (!text) {
    els.banner.hidden = true;
    return;
  }
  els.banner.textContent = text;
  els.banner.hidden = false;
}

const placeholder = (text) => element('p', 'muted content__placeholder', text);

/* ---------- строки рынка ---------- */

function renderRow(row, isSignal) {
  const node = element('div', `row${isSignal ? ' row--signal' : ''}`);

  const label = element('div', 'row__score', outcomeLabel(row.market, row.outcome));
  label.append(element('span', 'row__market', MARKET_LABELS[row.market] ?? row.market));
  node.append(label);

  node.append(element('div', 'row__cell', percent(row.modelProb)));
  node.append(element('div', 'row__cell', decimal(row.marketOdds)));

  const edge = element('div', `row__cell edge ${row.edge >= 0 ? 'edge--pos' : 'edge--neg'}`);
  edge.textContent = signed(row.edge);
  if (isSignal && row.stake > 0) {
    edge.append(element('span', 'stake', ` ${percent(row.stake)} банка`));
  }
  node.append(edge);
  return node;
}

function renderMarketTable(entry, { onlySignals, minEdge }) {
  const visible = entry.markets
    .filter((row) => !onlySignals || row.edge >= minEdge)
    .sort((a, b) => b.edge - a.edge);

  if (visible.length === 0) {
    return element('div', 'empty', 'Преимущества выше порога нет.');
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
  return rows;
}

function progressBar(share) {
  const bar = element('div', 'odds-bar');
  const fill = element('div', 'odds-bar__fill');
  fill.style.width = `${(share * 100).toFixed(1)}%`;
  bar.append(fill);
  return bar;
}

/* ---------- карточки ---------- */

function renderTennisCard(entry, filters) {
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
  head.append(progressBar(entry.model.aWins));

  const probs = element('div', 'card__probs');
  probs.append(element('span', null, `победа ${percent(entry.model.aWins, 0)}`));
  probs.append(element('span', null, percent(1 - entry.model.aWins, 0)));
  head.append(probs);

  card.append(head, renderMarketTable(entry, filters));
  return card;
}

function renderFootballCard(entry, filters) {
  const card = element('article', 'card');
  const head = element('div', 'card__head');

  const teams = element('div', 'card__players');
  teams.append(element('span', null, entry.match.teams[0]));
  teams.append(element('span', 'card__vs', '—'));
  teams.append(element('span', null, entry.match.teams[1]));
  head.append(teams);

  const tags = element('div', 'card__tags');
  if (entry.match.competition) tags.append(element('span', null, entry.match.competition));
  tags.append(element('span', null, `xG 1Т ${decimal(entry.model.expectedGoals)}`));
  if (!entry.match.knownTeams) tags.append(element('span', 'warn', 'команды не в справочнике'));
  head.append(tags);

  head.append(progressBar(entry.model.goalChance));
  const probs = element('div', 'card__probs');
  probs.append(element('span', null, `гол в 1-м тайме ${percent(entry.model.goalChance, 0)}`));
  probs.append(element('span', null, `${decimal(entry.model.lambdaHome)} : ${decimal(entry.model.lambdaAway)}`));
  head.append(probs);

  card.append(head, renderMarketTable(entry, filters));
  return card;
}

function renderSignalsView(sport) {
  const payload = state.signals[sport];
  if (!payload) return [placeholder('Загрузка…')];

  const onlySignals = els.onlySignals.checked;
  const minEdge = Number(els.minEdge.value) / 100;
  const render = sport === 'tennis' ? renderTennisCard : renderFootballCard;

  const cards = payload.matches
    .map((entry) => ({ entry, best: Math.max(-1, ...entry.markets.map((m) => m.edge)) }))
    .filter(({ best }) => !onlySignals || best >= minEdge)
    .sort((a, b) => b.best - a.best)
    .map(({ entry }) => render(entry, { onlySignals, minEdge }));

  return cards.length ? cards : [placeholder('Нет матчей с преимуществом выше порога.')];
}

/* ---------- статистика ---------- */

const TENNIS_COLUMNS = [
  { key: 'name', title: 'игрок', align: 'left' },
  { key: 'spw', title: 'подача', format: (v) => percent(v) },
  { key: 'rpw', title: 'приём', format: (v) => percent(v) },
  { key: 'matches', title: 'матчей', format: (v) => (v == null ? '—' : String(v)) },
];

const FOOTBALL_COLUMNS = [
  { key: 'name', title: 'команда', align: 'left' },
  { key: 'goalIn1HShare', title: 'гол в 1Т', format: (v) => percent(v, 0) },
  { key: 'goals1HPerMatch', title: 'голов 1Т', format: (v) => decimal(v) },
  { key: 'matches', title: 'матчей', format: (v) => String(v) },
];

function renderStatsView() {
  const payload = state.stats[state.statsSport];
  if (!payload) return [placeholder('Загрузка…')];

  const nodes = [];
  if (payload.note) nodes.push(element('div', 'note', payload.note));

  if (payload.league) {
    const summary = element('div', 'note');
    summary.textContent =
      `Лига: голов за матч ${decimal(payload.league.full.home + payload.league.full.away)}, `
      + `в первом тайме ${decimal(payload.league.firstHalf.home + payload.league.firstHalf.away)}.`;
    nodes.push(summary);
  }

  if (!payload.rows?.length) {
    nodes.push(placeholder('Ничего не найдено.'));
    return nodes;
  }

  const columns = state.statsSport === 'tennis' ? TENNIS_COLUMNS : FOOTBALL_COLUMNS;
  const table = element('div', 'stats');

  const header = element('div', 'stats__row stats__row--head');
  for (const column of columns) {
    header.append(element('div', column.align === 'left' ? '' : 'stats__cell', column.title));
  }
  table.append(header);

  for (const row of payload.rows.slice(0, 100)) {
    const line = element('div', 'stats__row');
    for (const column of columns) {
      const value = column.format ? column.format(row[column.key]) : row[column.key];
      line.append(element('div', column.align === 'left' ? 'stats__name' : 'stats__cell', value));
    }
    table.append(line);
  }

  nodes.push(table);
  if (payload.rows.length > 100) {
    nodes.push(element('div', 'note', `Показаны первые 100 из ${payload.rows.length}. Уточни поиск.`));
  }
  return nodes;
}

/* ---------- отрисовка ---------- */

function render() {
  els.edgeValue.textContent = `${els.minEdge.value}%`;
  els.footNote.textContent = FOOT_NOTES[state.tab];

  const isStats = state.tab === 'stats';
  els.filters.hidden = isStats;
  els.statsControls.hidden = !isStats;

  for (const tab of els.tabs) {
    tab.classList.toggle('tab--active', tab.dataset.tab === state.tab);
  }
  for (const button of els.statsSports) {
    button.classList.toggle('segmented__item--active', button.dataset.statsSport === state.statsSport);
  }

  if (isStats) {
    els.provider.textContent = state.statsSport === 'tennis' ? 'игроки' : 'команды';
    els.updated.textContent = '';
    els.content.replaceChildren(...renderStatsView());
    return;
  }

  const payload = state.signals[state.tab];
  els.provider.textContent = payload?.provider ?? '—';
  els.updated.textContent = payload?.generatedAt
    ? `обновлено ${new Date(payload.generatedAt).toLocaleTimeString('ru-RU')}`
    : '';
  els.content.replaceChildren(...renderSignalsView(state.tab));
}

/* ---------- загрузка ---------- */

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
  return res.json();
}

async function loadSignals(sport, { force = false } = {}) {
  els.refresh.disabled = true;
  try {
    const payload = await fetchJson(`/api/signals?sport=${sport}${force ? '&refresh=1' : ''}`);
    state.signals[sport] = payload;
    localStorage.setItem(`signals:${sport}`, JSON.stringify(payload));

    showBanner(
      payload.provider.includes('mock')
        ? 'Демо-данные. Боевой фид задаётся в .env (PROVIDER, API_TENNIS_KEY).'
        : null,
    );
  } catch (err) {
    const cached = localStorage.getItem(`signals:${sport}`);
    if (cached) {
      state.signals[sport] = JSON.parse(cached);
      showBanner(`Нет связи с сервером (${err.message}). Показаны последние данные.`);
    } else {
      state.signals[sport] = { provider: '—', matches: [] };
      showBanner(`Не удалось загрузить: ${err.message}`);
    }
  } finally {
    els.refresh.disabled = false;
    render();
  }
}

async function loadStats(sport, query = '') {
  try {
    state.stats[sport] = await fetchJson(`/api/stats?sport=${sport}&q=${encodeURIComponent(query)}`);
  } catch (err) {
    state.stats[sport] = { rows: [], note: `Не удалось загрузить: ${err.message}` };
  }
  render();
}

/* ---------- события ---------- */

function openTab(tab) {
  state.tab = tab;
  render();

  if (tab === 'stats') {
    if (!state.stats[state.statsSport]) loadStats(state.statsSport);
  } else if (!state.signals[tab]) {
    loadSignals(tab);
  }
}

for (const tab of els.tabs) {
  tab.addEventListener('click', () => openTab(tab.dataset.tab));
}

for (const button of els.statsSports) {
  button.addEventListener('click', () => {
    state.statsSport = button.dataset.statsSport;
    els.statsSearch.value = '';
    render();
    loadStats(state.statsSport);
  });
}

let searchTimer;
els.statsSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadStats(state.statsSport, els.statsSearch.value.trim()), 250);
});

els.refresh.addEventListener('click', () => {
  if (state.tab === 'stats') loadStats(state.statsSport, els.statsSearch.value.trim());
  else loadSignals(state.tab, { force: true });
});

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

loadSignals('tennis');
