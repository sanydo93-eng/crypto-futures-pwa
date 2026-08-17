/**
 * Вероятность выиграть тай-брейк.
 *
 * Подача в тай-брейке идёт с периодом 4: A, B, B, A | A, B, B, A | ...
 * Первым подаёт игрок A (то есть тот, чья очередь подавать по ходу сета).
 *
 * @param {number} pA вероятность A выиграть очко на СВОЕЙ подаче
 * @param {number} pB вероятность B выиграть очко на СВОЕЙ подаче
 * @param {number} target до скольких очков (7 — обычный, 10 — супер-тай-брейк)
 * @returns {number} вероятность победы A
 */
export function tiebreakWinProbability(pA, pB, target = 7) {
  // При счёте target-1 : target-1 нужно взять два очка подряд. За любые два
  // подряд идущих очка ровно одно подаёт A и одно B (в каком порядке — не важно,
  // произведения одинаковые), поэтому состояние сводится к одной формуле.
  const bothA = pA * (1 - pB); // A забирает оба очка
  const bothB = pB * (1 - pA); // B забирает оба очка
  const fromTied = bothA + bothB === 0 ? 0.5 : bothA / (bothA + bothB);

  const cap = target - 1;
  const memo = new Map();

  function f(a, b) {
    if (a === target && b <= target - 2) return 1;
    if (b === target && a <= target - 2) return 0;
    if (a === cap && b === cap) return fromTied;

    const key = a * 100 + b;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    // Период подачи — 4 очка: индексы 0 и 3 подаёт A, индексы 1 и 2 — B.
    const n = a + b;
    const aServes = n % 4 === 0 || n % 4 === 3;
    const pAWinsPoint = aServes ? pA : 1 - pB;

    const result = pAWinsPoint * f(a + 1, b) + (1 - pAWinsPoint) * f(a, b + 1);
    memo.set(key, result);
    return result;
  }

  return f(0, 0);
}
