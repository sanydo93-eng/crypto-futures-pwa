import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateMatch, modelMatch } from '../src/signals.js';
import * as mock from '../src/providers/mock.js';

const baseMatch = {
  id: 't1',
  tournament: 'Тест',
  surface: 'hard',
  tour: 'atp',
  bestOf: 3,
  aServesFirst: true,
  players: {
    a: { name: 'A', spw: 0.67, rpw: 0.38 },
    b: { name: 'B', spw: 0.63, rpw: 0.36 },
  },
  markets: { correctScore: { '2-0': 2.4, '2-1': 4.0, '1-2': 6.0, '0-2': 7.5 } },
};

test('модель матча покрывает все исходы по счёту', () => {
  const model = modelMatch(baseMatch);
  const total = model.scores.reduce((s, x) => s + x.prob, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.ok(model.pA > model.pB, 'более сильный игрок должен получить большую подачу');
});

test('разбор матча возвращает рынок целиком, а сигналы — только отобранные', () => {
  const result = evaluateMatch(baseMatch);

  assert.equal(result.markets.length, 4, 'в разборе должны быть все исходы рынка');
  assert.ok(result.signals.length <= result.markets.length);
  for (const signal of result.signals) {
    assert.ok(signal.edge >= 0.05, 'сигнал ниже порога преимущества');
    assert.ok(signal.modelProb >= 0.02, 'сигнал по слишком редкому исходу');
  }
});

test('явно завышенный коэффициент превращается в сигнал', () => {
  const generous = structuredClone(baseMatch);
  // Задираем цену на самый вероятный исход втрое — преимущество обязано вылезти.
  generous.markets.correctScore['2-0'] = 12;

  const result = evaluateMatch(generous);
  const signal = result.signals.find((s) => s.outcome === '2-0');

  assert.ok(signal, 'ожидался сигнал на переоценённом исходе');
  assert.ok(signal.edge > 1, `преимущество должно быть большим, получено ${signal.edge}`);
  assert.ok(signal.stake > 0, 'при положительном преимуществе Келли обязан дать ставку');
});

test('справедливый рынок не порождает сигналов', () => {
  const model = modelMatch(baseMatch);
  const fair = structuredClone(baseMatch);

  // Ставим коэффициенты ровно по модели — преимущество должно занулиться.
  fair.markets.correctScore = Object.fromEntries(
    model.scores.map((s) => [s.label, 1 / s.prob]),
  );

  const result = evaluateMatch(fair);
  assert.equal(result.signals.length, 0);
  for (const market of result.markets) {
    assert.ok(Math.abs(market.edge) < 1e-9, `остаточное преимущество ${market.edge}`);
  }
});

test('порог преимущества настраивается', () => {
  const loose = evaluateMatch(baseMatch, { minEdge: -1 });
  assert.equal(loose.signals.length, loose.markets.length);
});

test('демо-провайдер отдаёт пригодные для модели матчи', async () => {
  const matches = await mock.fetchMatches();
  assert.ok(matches.length > 0);

  for (const match of matches) {
    const result = evaluateMatch(match);
    assert.ok(result.model.scores.length > 0);
    assert.ok(result.match.players.length === 2);

    const total = result.model.scores.reduce((s, x) => s + x.prob, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `распределение не сошлось для ${match.id}`);
  }
});

test('демо-провайдер отдаёт независимые копии', async () => {
  const first = await mock.fetchMatches();
  first[0].tournament = 'изменено';
  const second = await mock.fetchMatches();
  assert.notEqual(second[0].tournament, 'изменено');
});
