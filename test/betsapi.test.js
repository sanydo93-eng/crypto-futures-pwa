import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOdds,
  flattenMarkets,
  extractFirstHalfMarkets,
  mapUpcomingEvent,
} from '../src/providers/football/betsapi.js';
import { evaluateFixture } from '../src/football/signals.js';
import { buildStrengths } from '../src/football/strength.js';
import { normalizeTeamName, canonicalTeamName } from '../src/football/names.js';

/**
 * ВАЖНО про эти тесты: фикстура ниже воссоздана по документации BetsAPI, а не
 * снята с живого ответа — токена и доступа к api.b365api.com у меня не было.
 * Тесты доказывают, что разбор внутренне согласован и устойчив к неполным
 * данным. Они НЕ доказывают, что схема совпадает с реальной — это проверяется
 * командой `npm run probe -- --sport football --raw`.
 */
const PREMATCH = {
  FI: '1234',
  event_id: '1234',
  main: {
    sp: {
      full_time_result: {
        name: 'Full Time Result',
        odds: [
          { id: 'a', odds: '5/4', header: '1', name: 'Arsenal' },
          { id: 'b', odds: '5/2', header: 'X', name: 'Draw' },
          { id: 'c', odds: '2/1', header: '2', name: 'Chelsea' },
        ],
      },
      half_time_result: {
        name: 'Half Time Result',
        odds: [
          { id: 'd', odds: '6/4', header: '1', name: 'Arsenal' },
          { id: 'e', odds: '11/10', header: 'X', name: 'Draw' },
          { id: 'f', odds: '4/1', header: '2', name: 'Chelsea' },
        ],
      },
    },
  },
  goals: {
    sp: {
      first_half_goals: {
        name: 'First Half Goals',
        odds: [
          { id: 'g', odds: '1/4', header: 'Over', name: '0.5', handicap: '0.5' },
          { id: 'h', odds: '11/4', header: 'Under', name: '0.5', handicap: '0.5' },
          { id: 'i', odds: '6/5', header: 'Over', name: '1.5', handicap: '1.5' },
          { id: 'j', odds: '4/6', header: 'Under', name: '1.5', handicap: '1.5' },
        ],
      },
    },
  },
  half: {
    sp: {
      half_time_correct_score: {
        name: 'Half Time Correct Score',
        odds: [
          { id: 'k', odds: '3/1', header: '1', name: '1-0' },
          { id: 'l', odds: '6/1', header: '1', name: '2-0' },
          { id: 'm', odds: '9/4', header: 'X', name: '0-0' },
          { id: 'n', odds: '12/1', header: 'X', name: '1-1' },
          { id: 'o', odds: '5/1', header: '2', name: '1-0' },
        ],
      },
    },
  },
};

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `ожидалось ${expected}, получено ${actual}`);

/* ---------- коэффициенты ---------- */

test('коэффициенты: дробный формат переводится в десятичный', () => {
  close(parseOdds('6/4'), 2.5);
  close(parseOdds('1/1'), 2);
  close(parseOdds('1/4'), 1.25);
  close(parseOdds('10/11'), 1 + 10 / 11);
});

test('коэффициенты: равные шансы и десятичный формат', () => {
  close(parseOdds('EVS'), 2);
  close(parseOdds('evs'), 2);
  close(parseOdds('2.50'), 2.5);
  close(parseOdds(3.4), 3.4);
});

test('коэффициенты: мусор отбраковывается, а не превращается в число', () => {
  for (const bad of [null, undefined, '', '  ', 'SUSP', '1.0', '0.5', '5/0', 'x/y']) {
    assert.equal(parseOdds(bad), null, `не отбраковано: ${JSON.stringify(bad)}`);
  }
});

/* ---------- поиск рынков ---------- */

test('рынки собираются из всех групп ответа', () => {
  const flat = flattenMarkets(PREMATCH);
  const names = flat.map((m) => m.name);

  assert.ok(names.includes('Half Time Result'));
  assert.ok(names.includes('First Half Goals'));
  assert.ok(names.includes('Half Time Correct Score'));
  assert.equal(flat.length, 4);
});

test('пустой или неожиданный ответ не роняет разбор', () => {
  assert.deepEqual(flattenMarkets(null), []);
  assert.deepEqual(flattenMarkets({}), []);
  assert.deepEqual(flattenMarkets({ main: { sp: { broken: { name: 'x' } } } }), []);

  const { markets, found } = extractFirstHalfMarkets({});
  assert.deepEqual(markets, {});
  assert.deepEqual(found, []);
});

/* ---------- рынки первого тайма ---------- */

test('линия 0.5 становится рынком «гол в первом тайме»', () => {
  const { markets } = extractFirstHalfMarkets(PREMATCH);
  close(markets.firstHalfGoal.yes, 1.25);
  close(markets.firstHalfGoal.no, 3.75);
});

test('линия 1.5 становится тоталом тайма', () => {
  const { markets } = extractFirstHalfMarkets(PREMATCH);
  close(markets.firstHalfTotal15.over, 2.2);
  close(markets.firstHalfTotal15.under, 1 + 4 / 6);
});

test('исход тайма разбирается по колонкам 1 / X / 2', () => {
  const { markets } = extractFirstHalfMarkets(PREMATCH);
  close(markets.firstHalfResult['1'], 2.5);
  close(markets.firstHalfResult.X, 2.1);
  close(markets.firstHalfResult['2'], 5);
});

test('исход тайма берётся только полным набором', () => {
  // Без ничьей снятие маржи посчитало бы не то, поэтому рынок отбрасывается.
  const partial = structuredClone(PREMATCH);
  partial.main.sp.half_time_result.odds = partial.main.sp.half_time_result.odds
    .filter((o) => o.header !== 'X');

  const { markets, found } = extractFirstHalfMarkets(partial);
  assert.equal(markets.firstHalfResult, undefined);
  assert.ok(!found.includes('firstHalfResult'));
});

test('счёт в колонке гостей переворачивается', () => {
  const { markets } = extractFirstHalfMarkets(PREMATCH);
  // «1-0» под заголовком «2» означает победу гостей, то есть 0:1.
  close(markets.firstHalfScore['0-1'], 6);
  close(markets.firstHalfScore['1-0'], 4);
  close(markets.firstHalfScore['0-0'], 3.25);
  close(markets.firstHalfScore['1-1'], 13);
});

test('переворот счёта отключается флагом', () => {
  const { markets } = extractFirstHalfMarkets(PREMATCH, { swapAwayColumn: false });
  // Без переворота обе записи «1-0» схлопнутся в одну — признак того,
  // что интерпретация колонок выбрана неверно.
  assert.equal(markets.firstHalfScore['0-1'], undefined);
});

test('находятся все четыре рынка', () => {
  const { found } = extractFirstHalfMarkets(PREMATCH);
  assert.deepEqual(
    [...found].sort(),
    ['firstHalfGoal', 'firstHalfResult', 'firstHalfScore', 'firstHalfTotal15'],
  );
});

test('рынки ищутся и по названию, когда машинный ключ другой', () => {
  const renamed = { odds_group: { sp: { unknown_key_42: PREMATCH.goals.sp.first_half_goals } } };
  const { markets } = extractFirstHalfMarkets(renamed);
  close(markets.firstHalfGoal.yes, 1.25);
});

/* ---------- расписание ---------- */

test('событие расписания приводится к внутреннему виду', () => {
  const fixture = mapUpcomingEvent({
    id: 987,
    time: '1760000000',
    league: { name: 'England Premier League' },
    home: { name: 'Arsenal' },
    away: { name: 'Chelsea' },
  });

  assert.equal(fixture.id, '987');
  assert.equal(fixture.home, 'Arsenal');
  assert.equal(fixture.competition, 'England Premier League');
  assert.equal(fixture.startsAt, new Date(1760000000 * 1000).toISOString());
});

test('событие без времени не ломает разбор', () => {
  assert.equal(mapUpcomingEvent({ id: 1, home: {}, away: {} }).startsAt, null);
});

/* ---------- сопоставление названий ---------- */

test('названия команд приводятся к сопоставимому виду', () => {
  assert.equal(normalizeTeamName('Nott\'m Forest'), 'nottm forest');
  assert.equal(normalizeTeamName('Bayern München'), 'bayern munchen');
  assert.equal(normalizeTeamName('Brighton & Hove Albion'), 'brighton and hove albion');
  // Ничего не значащие приставки убираются.
  assert.equal(normalizeTeamName('FC Barcelona'), 'barcelona');
});

test('сокращения разворачиваются в общее написание', () => {
  assert.equal(canonicalTeamName('Man Utd'), canonicalTeamName('Manchester United'));
  assert.equal(canonicalTeamName('Spurs'), canonicalTeamName('Tottenham Hotspur'));
  assert.equal(canonicalTeamName('PSG'), canonicalTeamName('Paris Saint-Germain'));
});

test('справочник находит команду по написанию букмекера', () => {
  const strengths = buildStrengths([
    { home: 'Man United', away: 'Tottenham', hg: 2, ag: 1, hthg: 1, htag: 0 },
    { home: 'Tottenham', away: 'Man United', hg: 0, ag: 0, hthg: 0, htag: 0 },
  ]);

  assert.equal(strengths.resolve('Man Utd'), 'Man United');
  assert.equal(strengths.resolve('Spurs'), 'Tottenham');
  assert.equal(strengths.resolve('никого'), null);
  assert.ok(strengths.has('Man Utd'));
  assert.equal(strengths.expectedGoals('Man Utd', 'Spurs').known, true);
});

/* ---------- сквозная проверка ---------- */

test('разобранные рынки годятся модели без доработки', () => {
  const { markets } = extractFirstHalfMarkets(PREMATCH);
  const strengths = buildStrengths([
    { home: 'Arsenal', away: 'Chelsea', hg: 2, ag: 1, hthg: 1, htag: 1 },
    { home: 'Chelsea', away: 'Arsenal', hg: 1, ag: 1, hthg: 0, htag: 1 },
  ]);

  const result = evaluateFixture(
    { id: '1234', home: 'Arsenal', away: 'Chelsea', competition: 'АПЛ', markets },
    {},
    strengths,
  );

  assert.equal(result.sport, 'football');
  assert.ok(result.markets.length >= 4, 'должны разобраться все рынки');
  for (const row of result.markets) {
    assert.ok(Number.isFinite(row.edge), `преимущество не число для ${row.outcome}`);
    assert.ok(row.marketOdds > 1);
  }
});
