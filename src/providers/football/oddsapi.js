import { TeamStrengths } from '../../football/strength.js';

/**
 * Провайдер The Odds API — бесплатный тариф на 500 запросов в месяц.
 *
 * Ключ выдаётся за минуту на the-odds-api.com/#get-access, карта не нужна.
 *
 * Чего здесь нет и не будет: котировок на первый тайм. Их не отдаёт ни один
 * бесплатный источник — это премиум-рынок. Поэтому провайдер работает с
 * рынками матча целиком: исход, тоталы, обе забьют. Модель считает их той же
 * пуассоновской сеткой, просто по ожидаемым голам за весь матч.
 *
 * Схема ответа проверена по документации v4, но не на живом ключе:
 *   npm run probe -- --sport football --raw
 */

const BASE_URL = 'https://api.the-odds-api.com/v4';

/** Ключи лиг у The Odds API. Полный список: /v4/sports */
export const LEAGUES = {
  epl: 'soccer_epl',
  laliga: 'soccer_spain_la_liga',
  seriea: 'soccer_italy_serie_a',
  bundesliga: 'soccer_germany_bundesliga',
  ligue1: 'soccer_france_ligue_one',
  ucl: 'soccer_uefa_champs_league',
  rpl: 'soccer_russia_premier_league',
};

const decimal = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
};

/**
 * Лучшая цена по каждому исходу среди всех букмекеров: именно по ней и
 * пришлось бы ставить, поэтому сравнивать модель нужно с ней, а не со средней.
 */
export function extractMarkets(event) {
  const best = {};
  const remember = (market, outcome, price) => {
    if (price == null) return;
    best[market] ??= {};
    if (!best[market][outcome] || price > best[market][outcome]) {
      best[market][outcome] = price;
    }
  };

  for (const bookmaker of event.bookmakers ?? []) {
    for (const market of bookmaker.markets ?? []) {
      for (const outcome of market.outcomes ?? []) {
        const price = decimal(outcome.price);
        const name = String(outcome.name ?? '');

        if (market.key === 'h2h') {
          // Исходы названы именами команд, а не 1/X/2.
          if (name === event.home_team) remember('matchResult', '1', price);
          else if (name === event.away_team) remember('matchResult', '2', price);
          else if (/^draw$/i.test(name)) remember('matchResult', 'X', price);
        } else if (market.key === 'totals') {
          const line = Number(outcome.point);
          const side = /^over$/i.test(name) ? 'over' : /^under$/i.test(name) ? 'under' : null;
          if (!side || !Number.isFinite(line)) continue;
          // Поддерживаем те линии, которые умеет считать модель.
          const target = { 1.5: 'matchTotal15', 2.5: 'matchTotal25', 3.5: 'matchTotal35' }[line];
          if (target) remember(target, side, price);
        } else if (market.key === 'btts') {
          if (/^yes$/i.test(name)) remember('matchBtts', 'yes', price);
          else if (/^no$/i.test(name)) remember('matchBtts', 'no', price);
        }
      }
    }
  }

  // Рынок годится только полным набором исходов, иначе снятие маржи посчитает не то.
  const complete = {};
  const required = {
    matchResult: ['1', 'X', '2'],
    matchTotal15: ['over', 'under'],
    matchTotal25: ['over', 'under'],
    matchTotal35: ['over', 'under'],
    matchBtts: ['yes', 'no'],
  };

  for (const [market, outcomes] of Object.entries(best)) {
    if (required[market].every((key) => outcomes[key])) complete[market] = outcomes;
  }
  return complete;
}

export function mapEvent(event) {
  return {
    id: String(event.id),
    competition: event.sport_title ?? event.sport_key ?? 'н/д',
    home: event.home_team ?? '',
    away: event.away_team ?? '',
    startsAt: event.commence_time ?? null,
  };
}

export const name = 'odds-api';

export function createProvider(config) {
  const {
    apiKey,
    statsPath = 'data/football-E0.json',
    leagues = ['soccer_epl'],
    regions = 'eu',
    maxEvents = 40,
  } = config;

  if (!apiKey) throw new Error('odds-api: не задан ODDS_API_KEY');

  let strengthsPromise;

  async function call(path, params = {}) {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('apiKey', apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) throw new Error('odds-api: ключ отклонён');
    if (res.status === 429) throw new Error('odds-api: исчерпан месячный лимит запросов');
    if (!res.ok) throw new Error(`odds-api ${path}: HTTP ${res.status}`);

    // Остаток запросов приходит заголовком — на бесплатном тарифе он важен.
    const left = res.headers.get('x-requests-remaining');
    if (left != null) console.error(`  [odds-api] запросов осталось: ${left}`);

    return res.json();
  }

  async function fetchEvents() {
    const events = [];
    for (const league of leagues) {
      try {
        const batch = await call(`/sports/${league}/odds`, {
          regions,
          markets: 'h2h,totals',
          oddsFormat: 'decimal',
        });
        events.push(...(Array.isArray(batch) ? batch : []));
      } catch (err) {
        // Одна недоступная лига не должна ронять остальные.
        console.error(`  [odds-api] ${league}: ${err.message}`);
      }
    }
    return events.slice(0, maxEvents);
  }

  return {
    name,

    async fetchRaw() {
      const events = await fetchEvents();
      return { upcoming: events, prematch: events, event: events[0] ?? null };
    },

    async fetchFixtures() {
      strengthsPromise ??= TeamStrengths.load(statsPath);
      const strengths = await strengthsPromise;

      const fixtures = [];
      for (const event of await fetchEvents()) {
        const markets = extractMarkets(event);
        const mapped = mapEvent(event);

        fixtures.push({
          ...mapped,
          markets,
          hasOdds: Object.keys(markets).length > 0,
          knownHome: strengths?.resolve(mapped.home) ?? null,
          knownAway: strengths?.resolve(mapped.away) ?? null,
        });
      }

      return fixtures.sort((a, b) => Number(b.hasOdds) - Number(a.hasOdds));
    },

    async loadStrengths() {
      strengthsPromise ??= TeamStrengths.load(statsPath);
      return strengthsPromise;
    },
  };
}
