import test from 'node:test';
import assert from 'node:assert/strict';

import { extractMarkets, mapEvent, LEAGUES } from '../src/providers/football/oddsapi.js';
import { fullMatchMarkets } from '../src/football/markets.js';
import { evaluateFixture } from '../src/football/signals.js';

/**
 * Фикстура воссоздана по документации The Odds API v4, а не снята с живого
 * ключа. Тесты доказывают согласованность разбора, но не совпадение схемы —
 * это проверяется командой `npm run probe -- --sport football --raw`.
 */
const EVENT = {
  id: 'abc123',
  sport_key: 'soccer_epl',
  sport_title: 'EPL',
  commence_time: '2026-08-20T14:00:00Z',
  home_team: 'Arsenal',
  away_team: 'Chelsea',
  bookmakers: [
    {
      key: 'pinnacle',
      markets: [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Arsenal', price: 1.8 },
            { name: 'Chelsea', price: 4.2 },
            { name: 'Draw', price: 3.6 },
          ],
        },
        {
          key: 'totals',
          outcomes: [
            { name: 'Over', price: 1.9, point: 2.5 },
            { name: 'Under', price: 1.95, point: 2.5 },
          ],
        },
      ],
    },
    {
      key: 'betfair',
      markets: [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Arsenal', price: 1.85 },
            { name: 'Chelsea', price: 4.0 },
            { name: 'Draw', price: 3.7 },
          ],
        },
        {
          key: 'totals',
          outcomes: [
            { name: 'Over', price: 2.05, point: 2.5 },
            { name: 'Under', price: 1.88, point: 2.5 },
            { name: 'Over', price: 1.4, point: 1.5 },
            { name: 'Under', price: 2.9, point: 1.5 },
          ],
        },
      ],
    },
  ],
};

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `ожидалось ${expected}, получено ${actual}`);

/* ---------- разбор ---------- */

test('исходы 1X2 узнаются по именам команд', () => {
  const markets = extractMarkets(EVENT);
  assert.ok(markets.matchResult, 'рынок исхода должен найтись');
  // Имена команд, а не 1/X/2: сопоставление идёт с home_team и away_team.
  close(markets.matchResult['1'], 1.85);
  close(markets.matchResult['2'], 4.2);
  close(markets.matchResult.X, 3.7);
});

test('берётся лучшая цена по каждому исходу', () => {
  const markets = extractMarkets(EVENT);
  // Pinnacle даёт 1.8 на хозяев, Betfair 1.85 — ставить пришлось бы по второй.
  close(markets.matchResult['1'], 1.85);
  close(markets.matchTotal25.over, 2.05);
  close(markets.matchTotal25.under, 1.95);
});

test('тоталы раскладываются по линиям', () => {
  const markets = extractMarkets(EVENT);
  close(markets.matchTotal15.over, 1.4);
  close(markets.matchTotal15.under, 2.9);
  assert.equal(markets.matchTotal35, undefined, 'линии 3.5 в ответе не было');
});

test('неполный рынок отбрасывается целиком', () => {
  // Без ничьей снятие маржи посчитало бы не то.
  const partial = structuredClone(EVENT);
  for (const bookmaker of partial.bookmakers) {
    for (const market of bookmaker.markets) {
      if (market.key === 'h2h') {
        market.outcomes = market.outcomes.filter((o) => o.name !== 'Draw');
      }
    }
  }
  assert.equal(extractMarkets(partial).matchResult, undefined);
});

test('мусорные цены не превращаются в числа', () => {
  const broken = structuredClone(EVENT);
  broken.bookmakers = [{
    key: 'x',
    markets: [{
      key: 'h2h',
      outcomes: [
        { name: 'Arsenal', price: '1.0' },
        { name: 'Chelsea', price: null },
        { name: 'Draw', price: 'нет' },
      ],
    }],
  }];
  assert.equal(extractMarkets(broken).matchResult, undefined);
});

test('пустое событие не роняет разбор', () => {
  assert.deepEqual(extractMarkets({ bookmakers: [] }), {});
  assert.deepEqual(extractMarkets({}), {});
});

test('событие приводится к внутреннему виду', () => {
  const fixture = mapEvent(EVENT);
  assert.equal(fixture.id, 'abc123');
  assert.equal(fixture.home, 'Arsenal');
  assert.equal(fixture.competition, 'EPL');
  assert.equal(fixture.startsAt, '2026-08-20T14:00:00Z');
});

test('ключи лиг заданы в формате провайдера', () => {
  for (const key of Object.values(LEAGUES)) {
    assert.match(key, /^soccer_/, `непохоже на ключ The Odds API: ${key}`);
  }
});

/* ---------- рынки матча целиком ---------- */

test('матч: наборы исходов полны', () => {
  const m = fullMatchMarkets(1.5, 1.15);
  close(m.result['1'] + m.result.X + m.result['2'], 1, 1e-9);
  for (const total of [m.total15, m.total25, m.total35]) {
    close(total.over + total.under, 1, 1e-9);
  }
  close(m.btts.yes + m.btts.no, 1, 1e-9);
});

test('матч: значения правдоподобны для средней лиги', () => {
  const m = fullMatchMarkets(1.5, 1.15);
  // Ориентиры по реальным лигам: хозяева около 45%, тотал больше 2.5 около 50%,
  // обе забьют около 50%.
  assert.ok(m.result['1'] > 0.4 && m.result['1'] < 0.5, `1: ${m.result['1']}`);
  assert.ok(m.total25.over > 0.45 && m.total25.over < 0.56, `ТБ2.5: ${m.total25.over}`);
  assert.ok(m.btts.yes > 0.45 && m.btts.yes < 0.6, `обе забьют: ${m.btts.yes}`);
});

test('матч: тоталы убывают с ростом линии', () => {
  const m = fullMatchMarkets(1.6, 1.3);
  assert.ok(m.total15.over > m.total25.over);
  assert.ok(m.total25.over > m.total35.over);
});

test('матч: разгромный перевес отражается в исходе', () => {
  const m = fullMatchMarkets(2.6, 0.5);
  assert.ok(m.result['1'] > 0.75, `слабый фаворит: ${m.result['1']}`);
});

/* ---------- сквозная проверка ---------- */

test('разобранные рынки годятся модели без доработки', () => {
  const markets = extractMarkets(EVENT);
  const result = evaluateFixture(
    { id: 'abc123', home: 'Arsenal', away: 'Chelsea', lambdaHome: 0.7, lambdaAway: 0.55, markets },
  );

  assert.ok(result.markets.length >= 5, `разобрано мало рынков: ${result.markets.length}`);
  for (const row of result.markets) {
    assert.ok(Number.isFinite(row.edge));
    assert.ok(row.marketOdds > 1);
    assert.ok(row.modelProb >= 0 && row.modelProb <= 1);
  }
  // Ожидаемые голы за матч выведены из таймовых, значит заметно больше них.
  assert.ok(result.model.fullExpectedGoals > result.model.expectedGoals);
});
