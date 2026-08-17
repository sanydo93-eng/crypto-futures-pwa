/**
 * Пуассоновская модель счёта с поправкой Диксона — Коулза.
 */

const factorial = (() => {
  const cache = [1];
  return (n) => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] * i;
    return cache[n];
  };
})();

export function poissonPmf(k, lambda) {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * lambda ** k) / factorial(k);
}

/**
 * Поправка Диксона — Коулза на низкие счета.
 *
 * Независимый Пуассон систематически занижает 0:0 и 1:1 и завышает 1:0 и 0:1 —
 * это и обнаружили Dixon & Coles (1997). Для первого тайма поправка особенно
 * важна: там почти все исходы как раз низкие, и без неё рынок «гол в первом
 * тайме» смещается на несколько процентов.
 *
 * Параметр rho отрицательный. Область допустимых значений ограничена: при
 * слишком большом по модулю rho вероятности уходят в минус, поэтому зажимаем.
 */
export function dixonColesTau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

export function clampRho(rho, lambda, mu) {
  const lower = Math.max(-1 / lambda, -1 / mu);
  const upper = Math.min(1 / (lambda * mu), 1);
  return Math.min(upper, Math.max(lower, rho));
}

/**
 * Совместное распределение счёта: grid[h][a] — вероятность счёта h:a.
 *
 * @param {number} lambdaHome ожидаемые голы хозяев
 * @param {number} lambdaAway ожидаемые голы гостей
 * @param {{maxGoals?:number, rho?:number}} options
 */
export function scoreGrid(lambdaHome, lambdaAway, options = {}) {
  const { maxGoals = 8, rho = -0.1 } = options;
  const safeRho = clampRho(rho, lambdaHome, lambdaAway);

  const home = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, lambdaHome));
  const away = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, lambdaAway));

  const grid = [];
  let total = 0;

  for (let h = 0; h <= maxGoals; h++) {
    grid[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const value = home[h] * away[a] * dixonColesTau(h, a, lambdaHome, lambdaAway, safeRho);
      grid[h][a] = value;
      total += value;
    }
  }

  // Нормировка нужна дважды: сетка обрезана по maxGoals, и поправка tau
  // сама по себе не сохраняет сумму строго равной единице.
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) grid[h][a] /= total;
  }

  return { grid, maxGoals, rho: safeRho };
}
