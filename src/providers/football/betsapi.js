import { TeamStrengths } from '../../football/strength.js';

/**
 * Провайдер BetsAPI (b365api) для рынков первого тайма.
 *
 * ВНИМАНИЕ ПРО СХЕМУ. Разбор ниже написан по документации BetsAPI, но на живом
 * токене не проверялся — доступа к api.b365api.com у меня не было. Названия
 * рынков и полей у букмекера меняются, поэтому перед боевым использованием:
 *
 *   npm run probe -- --sport football --raw
 *
 * Команда покажет сырой ответ и результат разбора. Расхождения правятся в
 * MARKET_MATCHERS ниже. Разъехавшийся маппинг не падает с ошибкой — он молча
 * даёт неверные сигналы, поэтому шаг обязательный.
 *
 * Документация: https://betsapi.com/docs/
 */

const BASE_URL = 'https://api.b365api.com';
const SOCCER = 1;

/* ------------------------------------------------------------------ */
/* Разбор коэффициентов                                                */
/* ------------------------------------------------------------------ */

/**
 * Bet365 отдаёт коэффициенты дробью («6/4»), иногда десятичным числом,
 * а равные шансы — словом «EVS».
 *
 * @returns {number|null} десятичный коэффициент либо null, если значение мусорное
 */
export function parseOdds(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '') return null;

  if (/^evs$/i.test(text)) return 2;

  if (text.includes('/')) {
    const [numerator, denominator] = text.split('/').map(Number);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return null;
    }
    return numerator / denominator + 1;
  }

  const decimal = Number(text);
  // Десятичный коэффициент строго больше единицы; всё остальное — не цена.
  return Number.isFinite(decimal) && decimal > 1 ? decimal : null;
}

/* ------------------------------------------------------------------ */
/* Поиск рынков в ответе                                               */
/* ------------------------------------------------------------------ */

/**
 * Ответ prematch разложен по группам (main, goals, half, ...), внутри каждой —
 * объект `sp` с рынками. Собираем всё в плоский список, чтобы не зависеть от
 * того, в какой именно группе букмекер держит нужный рынок.
 */
export function flattenMarkets(result) {
  const markets = [];
  for (const [groupName, group] of Object.entries(result ?? {})) {
    const sp = group?.sp;
    if (!sp || typeof sp !== 'object') continue;

    for (const [key, market] of Object.entries(sp)) {
      if (!market || !Array.isArray(market.odds)) continue;
      markets.push({
        group: groupName,
        key,
        name: market.name ?? key,
        odds: market.odds,
      });
    }
  }
  return markets;
}

/** Рынок ищем и по машинному ключу, и по человеческому названию. */
const MARKET_MATCHERS = {
  firstHalfTotals: (m) =>
    /first_half_goals|1st_half_goals|half_time_goals|first_half_total/.test(m.key)
    || /(first|1st)\s*half.*(goals|total)|goals.*(first|1st)\s*half/i.test(m.name),
  firstHalfResult: (m) =>
    /half_time_result|1st_half_result|first_half_result/.test(m.key)
    || /half.?time result|(first|1st)\s*half result/i.test(m.name),
  firstHalfScore: (m) =>
    /half_time_correct_score|1st_half_correct_score/.test(m.key)
    || /half.?time correct score|(first|1st)\s*half correct score/i.test(m.name),
};

const findMarket = (markets, kind) => markets.find(MARKET_MATCHERS[kind]);

const handicapOf = (entry) => {
  const raw = entry.handicap ?? entry.name;
  const parsed = Number(String(raw ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

const isOver = (entry) => /over/i.test(`${entry.header ?? ''} ${entry.name ?? ''}`);
const isUnder = (entry) => /under/i.test(`${entry.header ?? ''} ${entry.name ?? ''}`);

/**
 * Тоталы первого тайма. Линия 0.5 — это и есть рынок «гол в первом тайме»,
 * линия 1.5 — тотал.
 */
function extractTotals(market) {
  const byLine = new Map();
  if (!market) return byLine;

  for (const entry of market.odds) {
    const line = handicapOf(entry);
    const odds = parseOdds(entry.odds);
    if (line == null || odds == null) continue;

    const side = isOver(entry) ? 'over' : isUnder(entry) ? 'under' : null;
    if (!side) continue;

    if (!byLine.has(line)) byLine.set(line, {});
    byLine.get(line)[side] = odds;
  }
  return byLine;
}

function extractResult(market) {
  if (!market) return null;

  const outcomes = {};
  for (const entry of market.odds) {
    const odds = parseOdds(entry.odds);
    if (odds == null) continue;

    const label = String(entry.header ?? '').trim();
    const text = String(entry.name ?? '').trim();

    if (label === '1' || /^home$/i.test(text)) outcomes['1'] = odds;
    else if (label === '2' || /^away$/i.test(text)) outcomes['2'] = odds;
    else if (/^x$/i.test(label) || /^draw$/i.test(text)) outcomes.X = odds;
  }

  // Рынок годится только целиком: неполный набор исходов испортит снятие маржи.
  return outcomes['1'] && outcomes.X && outcomes['2'] ? outcomes : null;
}

/**
 * Точный счёт тайма.
 *
 * Тонкость bet365: счета сгруппированы колонками 1 / X / 2, и в колонке «2»
 * они записаны со стороны гостей — «1-0» там означает 0:1 в привычной записи
 * «хозяева-гости». Поэтому такие счета переворачиваются.
 */
function extractCorrectScore(market, { swapAwayColumn = true } = {}) {
  if (!market) return null;

  const outcomes = {};
  for (const entry of market.odds) {
    const odds = parseOdds(entry.odds);
    const match = String(entry.name ?? '').match(/^(\d+)\s*[-:]\s*(\d+)$/);
    if (odds == null || !match) continue;

    let [, first, second] = match;
    if (swapAwayColumn && String(entry.header ?? '').trim() === '2') {
      [first, second] = [second, first];
    }
    outcomes[`${Number(first)}-${Number(second)}`] = odds;
  }

  return Object.keys(outcomes).length ? outcomes : null;
}

/**
 * Рынки первого тайма из ответа prematch, в терминах модели.
 * @returns {{markets: object, found: string[]}}
 */
export function extractFirstHalfMarkets(prematchResult, options = {}) {
  const flat = flattenMarkets(prematchResult);
  const markets = {};
  const found = [];

  const totals = extractTotals(findMarket(flat, 'firstHalfTotals'));
  if (totals.get(0.5)?.over && totals.get(0.5)?.under) {
    markets.firstHalfGoal = { yes: totals.get(0.5).over, no: totals.get(0.5).under };
    found.push('firstHalfGoal');
  }
  if (totals.get(1.5)?.over && totals.get(1.5)?.under) {
    markets.firstHalfTotal15 = totals.get(1.5);
    found.push('firstHalfTotal15');
  }

  const result = extractResult(findMarket(flat, 'firstHalfResult'));
  if (result) {
    markets.firstHalfResult = result;
    found.push('firstHalfResult');
  }

  const score = extractCorrectScore(findMarket(flat, 'firstHalfScore'), options);
  if (score) {
    markets.firstHalfScore = score;
    found.push('firstHalfScore');
  }

  return { markets, found, available: flat.map((m) => m.name) };
}

/* ------------------------------------------------------------------ */
/* Расписание                                                          */
/* ------------------------------------------------------------------ */

export function mapUpcomingEvent(event) {
  const startsAt = Number(event.time) ? new Date(Number(event.time) * 1000).toISOString() : null;
  return {
    id: String(event.id),
    competition: event.league?.name ?? 'н/д',
    home: event.home?.name ?? '',
    away: event.away?.name ?? '',
    startsAt,
  };
}

/* ------------------------------------------------------------------ */
/* Провайдер                                                           */
/* ------------------------------------------------------------------ */

export const name = 'betsapi';

const chunk = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size));

export function createProvider(config) {
  const {
    token,
    statsPath = 'data/football-E0.json',
    leagues = [],
    maxEvents = 40,
    swapAwayColumn = true,
  } = config;

  if (!token) throw new Error('betsapi: не задан BETSAPI_TOKEN');

  let strengthsPromise;

  async function call(path, params) {
    const url = new URL(path, BASE_URL);
    url.searchParams.set('token', token);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      // 404 у BetsAPI означает и «нет данных», и «тариф не покрывает метод».
      throw new Error(`betsapi ${path}: HTTP ${res.status}`);
    }

    const body = await res.json();
    if (body.success !== 1) {
      throw new Error(`betsapi ${path}: ${body.error ?? 'запрос отклонён'}`);
    }
    return body.results ?? [];
  }

  const matchesLeague = (event) =>
    leagues.length === 0
    || leagues.some((needle) =>
      String(event.league?.name ?? '').toLowerCase().includes(needle.toLowerCase()));

  return {
    name,

    /** Сырые ответы для диагностики — используется scripts/probe-provider.js. */
    async fetchRaw({ day } = {}) {
      const upcoming = await call('/v1/bet365/upcoming', { sport_id: SOCCER, day });
      const first = upcoming.filter(matchesLeague)[0];
      if (!first) return { upcoming, prematch: null };

      const prematch = await call('/v3/bet365/prematch', { FI: first.id });
      return { upcoming, prematch, event: first };
    },

    async fetchFixtures({ day } = {}) {
      strengthsPromise ??= TeamStrengths.load(statsPath);
      const strengths = await strengthsPromise;

      const upcoming = (await call('/v1/bet365/upcoming', { sport_id: SOCCER, day }))
        .filter((event) => String(event.time_status ?? '0') === '0')
        .filter(matchesLeague)
        .slice(0, maxEvents);

      const events = new Map(upcoming.map((event) => [String(event.id), mapUpcomingEvent(event)]));

      // Коэффициенты запрашиваются пачками: BetsAPI считает каждый вызов
      // отдельно, а лимит запросов в тарифе конечен.
      const fixtures = [];
      for (const batch of chunk([...events.keys()], 10)) {
        const prematch = await call('/v3/bet365/prematch', { FI: batch.join(',') });

        for (const result of prematch) {
          const id = String(result.FI ?? result.event_id ?? '');
          const event = events.get(id);
          if (!event) continue;

          const { markets, found } = extractFirstHalfMarkets(result, { swapAwayColumn });
          if (found.length === 0) continue;

          fixtures.push({
            ...event,
            markets,
            // Ожидаемые голы модель возьмёт из справочника команд по именам.
            knownHome: strengths?.resolve(event.home) ?? null,
            knownAway: strengths?.resolve(event.away) ?? null,
          });
        }
      }

      return fixtures;
    },

    /** Справочник нужен модели, поэтому отдаём его наружу вместе с матчами. */
    async loadStrengths() {
      strengthsPromise ??= TeamStrengths.load(statsPath);
      return strengthsPromise;
    },
  };
}
