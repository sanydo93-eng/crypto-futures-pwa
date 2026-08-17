import test from 'node:test';
import assert from 'node:assert/strict';

import { devig, edge, kelly } from '../src/odds.js';
import { shrink, normalizeName } from '../src/tennis/stats.js';

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `ожидалось ${expected}, получено ${actual}`,
  );

const sum = (values) => values.reduce((a, b) => a + b, 0);

test('девиг: вероятности всегда суммируются в единицу', () => {
  for (const method of ['power', 'proportional']) {
    const { probabilities } = devig([2.1, 4.2, 6.5, 7.0], method);
    close(sum(probabilities), 1, 1e-9);
  }
});

test('девиг: маржа посчитана верно', () => {
  // Рынок без маржи: две равные цены 2.0 дают ровно 50/50.
  const fair = devig([2, 2]);
  close(fair.overround, 0, 1e-12);
  close(fair.probabilities[0], 0.5, 1e-9);

  // 1.9 / 1.9 — это перебор в 5.26%.
  const juiced = devig([1.9, 1.9]);
  close(juiced.overround, 2 / 1.9 - 1, 1e-12);
  close(juiced.probabilities[0], 0.5, 1e-9);
});

test('девиг: степенной метод сильнее срезает аутсайдеров, чем пропорциональный', () => {
  // На точном счёте это принципиально: маржа зашита в длинные исходы неравномерно.
  const odds = [1.4, 4.2, 9.5, 21];
  const power = devig(odds, 'power').probabilities;
  const proportional = devig(odds, 'proportional').probabilities;

  assert.ok(power.at(-1) < proportional.at(-1), 'аутсайдер должен получить меньше веса');
  assert.ok(power[0] > proportional[0], 'фаворит — больше');
});

test('девиг: степенной метод действительно решает уравнение', () => {
  const odds = [1.8, 3.6, 9, 15];
  const { probabilities, exponent } = devig(odds, 'power');
  assert.ok(exponent > 1, 'при наличии маржи показатель обязан быть больше единицы');

  // Каждая вероятность — это (1/o)^k, нормировка не должна ничего менять.
  for (const [i, o] of odds.entries()) {
    close(probabilities[i], (1 / o) ** exponent, 1e-6);
  }
});

test('девиг: рынок с отрицательной маржой не ломает подбор показателя', () => {
  // Сумма 1/o меньше единицы — вероятности всё равно обязаны сойтись к единице,
  // а показатель уйти ниже единицы.
  const { probabilities, exponent, overround } = devig([1.5, 6, 21, 51], 'power');
  assert.ok(overround < 0, 'проверяем именно случай отрицательной маржи');
  assert.ok(exponent < 1, `ожидался показатель меньше единицы, получен ${exponent}`);
  close(sum(probabilities), 1, 1e-9);
});

test('девиг: некорректный вход отвергается', () => {
  assert.throws(() => devig([]), TypeError);
  assert.throws(() => devig([1.0, 2.0]), RangeError);
  assert.throws(() => devig([0.5]), RangeError);
});

test('преимущество: считается как матожидание на единицу ставки', () => {
  close(edge(0.5, 2), 0);
  close(edge(0.6, 2), 0.2);
  close(edge(0.4, 2), -0.2);
});

test('Келли: не ставит там, где нет преимущества', () => {
  assert.equal(kelly(0.5, 2), 0);
  assert.equal(kelly(0.3, 2), 0);
});

test('Келли: доля банка соответствует формуле с поправкой на дробность', () => {
  // Полный Келли при p=0.6 и коэффициенте 2 равен 0.2.
  close(kelly(0.6, 2, 1), 0.2);
  close(kelly(0.6, 2, 0.25), 0.05);
});

test('усадка: маленькая выборка тянется к базовому уровню', () => {
  const baseline = 0.64;
  const noisy = shrink(0.8, 2, baseline, 20);
  const solid = shrink(0.8, 200, baseline, 20);

  assert.ok(Math.abs(noisy - baseline) < Math.abs(solid - baseline));
  close(shrink(0.8, 0, baseline, 20), baseline);
  close(shrink(0.8, 20, baseline, 20), (0.8 + baseline) / 2);
});

test('имена: приводятся к сопоставимому виду', () => {
  assert.equal(normalizeName('Novak Djoković'), normalizeName('novak djokovic'));
  assert.equal(normalizeName('J.-L. Struff'), 'j l struff');
  assert.equal(normalizeName('  Rafael   Nadal  '), 'rafael nadal');
});
