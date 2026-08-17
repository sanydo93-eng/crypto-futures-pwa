import test from 'node:test';
import assert from 'node:assert/strict';

import { gameWinProbability } from '../src/tennis/game.js';
import { tiebreakWinProbability } from '../src/tennis/tiebreak.js';
import { setDistribution } from '../src/tennis/set.js';
import { matchDistribution } from '../src/tennis/match.js';
import { serveProbabilities } from '../src/tennis/serve.js';

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `ожидалось ${expected}, получено ${actual} (допуск ${tolerance})`,
  );

const sum = (values) => values.reduce((a, b) => a + b, 0);

test('гейм: равные шансы на очко дают равные шансы на гейм', () => {
  close(gameWinProbability(0.5), 0.5);
});

test('гейм: вырожденные случаи', () => {
  close(gameWinProbability(0), 0);
  close(gameWinProbability(1), 1);
});

test('гейм: совпадает с точным значением для p=0.6', () => {
  // Проверено независимым перебором в рациональных дробях: ровно 29889/40625.
  close(gameWinProbability(0.6), 29889 / 40625, 1e-12);
});

test('гейм: подача усиливается монотонно', () => {
  let previous = -1;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const current = gameWinProbability(Math.min(p, 1));
    assert.ok(current > previous, `немонотонность на p=${p}`);
    previous = current;
  }
});

test('гейм: выигрыш гейма даётся тяжелее, чем очка, для сильного подающего', () => {
  // Преимущество на очке усиливается на уровне гейма.
  assert.ok(gameWinProbability(0.6) > 0.6);
  assert.ok(gameWinProbability(0.4) < 0.4);
});

test('тай-брейк: симметрия при равных подачах', () => {
  close(tiebreakWinProbability(0.6, 0.6), 0.5, 1e-9);
});

test('тай-брейк: вырожденные случаи', () => {
  close(tiebreakWinProbability(1, 0), 1);
  close(tiebreakWinProbability(0, 1), 0);
});

test('тай-брейк: перестановка игроков даёт дополнение до единицы', () => {
  // A подаёт первым в обоих случаях, поэтому строгая симметрия здесь
  // не обязана выполняться — но при равных подачах обязана.
  close(tiebreakWinProbability(0.55, 0.55) + tiebreakWinProbability(0.55, 0.55), 1, 1e-9);
});

test('тай-брейк: супер-тай-брейк до 10 очков сильнее давит случайность', () => {
  const short = tiebreakWinProbability(0.68, 0.6, 7);
  const long = tiebreakWinProbability(0.68, 0.6, 10);
  assert.ok(long > short, 'на более длинной дистанции фаворит должен выигрывать чаще');
});

test('сет: распределение по счёту суммируется в единицу', () => {
  const { scores } = setDistribution(0.65, 0.61);
  close(sum(scores.map((s) => s.prob)), 1, 1e-12);
});

test('сет: все счета допустимы правилами', () => {
  const allowed = new Set([
    '6-0', '6-1', '6-2', '6-3', '6-4', '7-5', '7-6',
    '0-6', '1-6', '2-6', '3-6', '4-6', '5-7', '6-7',
  ]);
  for (const s of setDistribution(0.64, 0.62).scores) {
    assert.ok(allowed.has(`${s.a}-${s.b}`), `недопустимый счёт ${s.a}-${s.b}`);
  }
});

test('сет: подача первым — единственная асимметрия при равных игроках', () => {
  const aFirst = setDistribution(0.64, 0.64, { aServesFirst: true });
  const bFirst = setDistribution(0.64, 0.64, { aServesFirst: false });
  close(aFirst.aWins + bFirst.aWins, 1, 1e-12);
  assert.ok(aFirst.aWins > 0.5, 'подающий первым имеет небольшое преимущество');
});

test('сет: зеркальная перестановка игроков и подачи', () => {
  // Поменять игроков местами и одновременно передать подачу — это тот же сет,
  // записанный с другой стороны. Проверяет учёт очерёдности подачи целиком.
  const direct = setDistribution(0.67, 0.59, { aServesFirst: true });
  const mirror = setDistribution(0.59, 0.67, { aServesFirst: false });
  close(direct.aWins, 1 - mirror.aWins, 1e-12);

  const key = (s) => `${s.a}-${s.b}`;
  const mirrored = new Map(mirror.scores.map((s) => [`${s.b}-${s.a}`, s.prob]));
  for (const score of direct.scores) {
    close(score.prob, mirrored.get(key(score)), 1e-12);
  }
});

test('сет: очерёдность подачи в следующем сете', () => {
  const { scores } = setDistribution(0.64, 0.62, { aServesFirst: true });
  const byScore = new Map(scores.map((s) => [`${s.a}-${s.b}`, s]));

  // 10 геймов сыграно — очередь снова доходит до A.
  assert.equal(byScore.get('6-4').nextAServesFirst, true);
  // 12 геймов — тоже A.
  assert.equal(byScore.get('7-5').nextAServesFirst, true);
  // 13 геймов: после тай-брейка первым подаёт тот, кто в нём принимал.
  assert.equal(byScore.get('7-6').nextAServesFirst, false);
});

test('матч: распределение суммируется в единицу для трёх и пяти сетов', () => {
  for (const bestOf of [3, 5]) {
    const { scores } = matchDistribution(0.66, 0.6, { bestOf });
    close(sum(scores.map((s) => s.prob)), 1, 1e-12);
  }
});

test('матч: счета соответствуют формату', () => {
  const three = matchDistribution(0.66, 0.6, { bestOf: 3 }).scores.map((s) => s.label).sort();
  assert.deepEqual(three, ['0-2', '1-2', '2-0', '2-1']);

  const five = matchDistribution(0.66, 0.6, { bestOf: 5 }).scores.map((s) => s.label).sort();
  assert.deepEqual(five, ['0-3', '1-3', '2-3', '3-0', '3-1', '3-2']);
});

test('матч: вероятность победы согласована со счётом', () => {
  const { scores, aWins } = matchDistribution(0.68, 0.6, { bestOf: 3 });
  const viaScores = sum(scores.filter((s) => s.winner === 'A').map((s) => s.prob));
  close(aWins, viaScores, 1e-12);
});

test('матч: пять сетов надёжнее выявляют фаворита', () => {
  const three = matchDistribution(0.68, 0.61, { bestOf: 3 }).aWins;
  const five = matchDistribution(0.68, 0.61, { bestOf: 5 }).aWins;
  assert.ok(five > three, 'длинная дистанция должна работать на фаворита');
});

test('матч: сильный подающий выигрывает почти всегда', () => {
  const { aWins } = matchDistribution(0.75, 0.55, { bestOf: 3 });
  assert.ok(aWins > 0.98, `ожидалось подавляющее преимущество, получено ${aWins}`);
});

test('подача: аддитивная модель учитывает силу приёма соперника', () => {
  const strongReturner = { spw: 0.6, rpw: 0.45 };
  const weakReturner = { spw: 0.6, rpw: 0.3 };
  const server = { spw: 0.66, rpw: 0.38 };

  const vsStrong = serveProbabilities(server, strongReturner, { tour: 'atp', surface: 'hard' });
  const vsWeak = serveProbabilities(server, weakReturner, { tour: 'atp', surface: 'hard' });

  assert.ok(vsStrong.pA < vsWeak.pA, 'против хорошего приёма подача должна проседать');
});

test('подача: значения не выходят за разумные границы', () => {
  const absurd = serveProbabilities(
    { spw: 0.99, rpw: 0.99 },
    { spw: 0.01, rpw: 0.01 },
    { tour: 'atp', surface: 'hard' },
  );
  assert.ok(absurd.pA <= 0.9 && absurd.pA >= 0.3);
  assert.ok(absurd.pB <= 0.9 && absurd.pB >= 0.3);
});
