import { PlayerStats } from '../stats.js';

/**
 * Провайдер api-tennis.com: расписание + коэффициенты.
 *
 * ВНИМАНИЕ про схему ответа. Разбор ниже написан по документации api-tennis,
 * но проверить его на живом ключе я не мог. Названия рынков и полей у провайдера
 * со временем меняются. Прежде чем доверять цифрам, выполни:
 *
 *   node scripts/probe-provider.js
 *
 * Скрипт выведет сырой ответ API. Сверь ключи с картой MARKET_ALIASES и
 * функцией mapFixture и поправь при расхождении — это 10 минут работы,
 * а молча разъехавшийся маппинг даст сигналы на пустом месте.
 */

const BASE_URL = 'https://api.api-tennis.com/tennis/';

/** Как рынок называется у провайдера -> как он зовётся внутри модели. */
const MARKET_ALIASES = {
  'Correct Score': 'correctScore',
  'Set Betting': 'correctScore',
  'Correct Score 1st Set': 'firstSetScore',
};

async function call(method, apiKey, params = {}) {
  const url = new URL(BASE_URL);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`api-tennis ${method}: HTTP ${res.status}`);
  }

  const body = await res.json();
  if (body.success !== 1 && !Array.isArray(body.result)) {
    throw new Error(`api-tennis ${method}: ${body.error ?? 'неожиданный ответ'}`);
  }
  return body.result ?? [];
}

const isSingles = (fixture) => /singles/i.test(fixture.event_type_type ?? '');

function detectTour(fixture) {
  return /wta/i.test(fixture.event_type_type ?? '') ? 'wta' : 'atp';
}

/**
 * Покрытие в фиде отсутствует, а для модели оно важно (на траве подача
 * решает сильнее, чем на грунте). Определяем по названию турнира, остальное
 * уходит в hard как наиболее частое.
 */
function detectSurface(fixture) {
  const name = `${fixture.tournament_name ?? ''}`.toLowerCase();
  if (/roland|garros|clay|madrid|rome|monte.?carlo|barcelona/.test(name)) return 'clay';
  if (/wimbledon|grass|queen|halle|eastbourne/.test(name)) return 'grass';
  return 'hard';
}

const isGrandSlam = (fixture) =>
  /australian open|roland|garros|wimbledon|us open/i.test(fixture.tournament_name ?? '');

/** Коэффициенты по точному счёту приходят как «2 - 0» и т.п. — приводим к «2-0». */
function normalizeOutcome(label) {
  return String(label).replace(/\s+/g, '').replace(/[:x]/i, '-');
}

function extractMarkets(oddsForMatch) {
  const markets = {};
  if (!oddsForMatch) return markets;

  for (const [providerName, internalName] of Object.entries(MARKET_ALIASES)) {
    const raw = oddsForMatch[providerName];
    if (!raw) continue;

    const outcomes = {};
    for (const [outcome, books] of Object.entries(raw)) {
      // На один исход приходит по коэффициенту от каждого букмекера.
      // Берём лучший — именно по нему и пришлось бы ставить.
      const values = Object.values(books ?? {}).map(Number).filter((v) => v > 1);
      if (values.length) outcomes[normalizeOutcome(outcome)] = Math.max(...values);
    }
    if (Object.keys(outcomes).length) markets[internalName] = outcomes;
  }
  return markets;
}

export const name = 'api-tennis';

/**
 * @param {{apiKey:string, statsPath?:string, date?:string, days?:number}} config
 */
export function createProvider(config) {
  const { apiKey, statsPath = 'data/player-stats.json' } = config;
  if (!apiKey) throw new Error('api-tennis: не задан API_TENNIS_KEY');

  let statsPromise;

  return {
    name,
    async fetchMatches({ date = new Date().toISOString().slice(0, 10), days = 1 } = {}) {
      statsPromise ??= PlayerStats.load(statsPath);
      const stats = await statsPromise;

      const dateStop = new Date(Date.parse(`${date}T00:00:00Z`) + (days - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);

      const [fixtures, odds] = await Promise.all([
        call('get_fixtures', apiKey, { date_start: date, date_stop: dateStop }),
        call('get_odds', apiKey, { date_start: date, date_stop: dateStop }),
      ]);

      // Коэффициенты приходят отдельным списком — сводим по ключу матча.
      const oddsByMatch = new Map();
      for (const entry of Array.isArray(odds) ? odds : Object.values(odds ?? {})) {
        const key = entry.match_key ?? entry.event_key;
        if (key != null) oddsByMatch.set(String(key), entry);
      }

      const matches = [];
      for (const fixture of fixtures) {
        if (!isSingles(fixture)) continue;

        const markets = extractMarkets(oddsByMatch.get(String(fixture.event_key)));
        if (!Object.keys(markets).length) continue;

        const tour = detectTour(fixture);
        const surface = detectSurface(fixture);
        const nameA = fixture.event_first_player;
        const nameB = fixture.event_second_player;

        const a = stats.lookup(nameA, { tour, surface });
        const b = stats.lookup(nameB, { tour, surface });

        matches.push({
          id: String(fixture.event_key),
          tournament: fixture.tournament_name ?? 'н/д',
          surface,
          tour,
          bestOf: tour === 'atp' && isGrandSlam(fixture) ? 5 : 3,
          startsAt: fixture.event_date ? `${fixture.event_date} ${fixture.event_time ?? ''}`.trim() : null,
          // Кто подаёт первым, до жеребьёвки неизвестно. Влияние на счёт
          // невелико, но оно есть — считаем от игрока A.
          aServesFirst: true,
          players: {
            a: { name: nameA, spw: a.spw, rpw: a.rpw, known: a.known, matches: a.matches },
            b: { name: nameB, spw: b.spw, rpw: b.rpw, known: b.known, matches: b.matches },
          },
          markets,
        });
      }
      return matches;
    },
  };
}
