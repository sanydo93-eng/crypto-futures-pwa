import { setDistribution } from './set.js';

function accumulate(map, key, value) {
  map.set(key, (map.get(key) ?? 0) + value);
}

/**
 * Распределение по точному счёту матча по сетам (2:0, 2:1, 1:2, 0:2 и т.д.).
 *
 * Порядок подачи между сетами учитывается точно: кто начинает следующий сет,
 * однозначно определяется числом геймов в предыдущем.
 *
 * Допущение модели: вероятность выиграть очко на подаче постоянна весь матч —
 * усталость, травмы и «инерция» не моделируются.
 *
 * @param {number} pA вероятность A выиграть очко на своей подаче
 * @param {number} pB вероятность B выиграть очко на своей подаче
 * @param {{bestOf?: 3|5, aServesFirst?: boolean}} options
 */
export function matchDistribution(pA, pB, options = {}) {
  const { bestOf = 3, aServesFirst = true } = options;
  const setsToWin = Math.ceil(bestOf / 2);

  // Распределение сета зависит только от того, кто в нём подаёт первым,
  // поэтому достаточно двух предрасчётов на весь матч.
  const byServer = {
    true: setDistribution(pA, pB, { aServesFirst: true }),
    false: setDistribution(pA, pB, { aServesFirst: false }),
  };

  const matchScores = new Map();
  let layer = new Map([[`0,0,${aServesFirst}`, 1]]);

  for (let set = 0; set < bestOf; set++) {
    const next = new Map();

    for (const [key, prob] of layer) {
      const [sa, sb, serverFlag] = key.split(',');
      const setsA = Number(sa);
      const setsB = Number(sb);

      for (const score of byServer[serverFlag].scores) {
        const nextA = setsA + (score.winner === 'A' ? 1 : 0);
        const nextB = setsB + (score.winner === 'B' ? 1 : 0);
        const p = prob * score.prob;

        if (nextA === setsToWin || nextB === setsToWin) {
          accumulate(matchScores, `${nextA}-${nextB}`, p);
        } else {
          accumulate(next, `${nextA},${nextB},${score.nextAServesFirst}`, p);
        }
      }
    }

    layer = next;
    if (layer.size === 0) break;
  }

  const scores = [...matchScores.entries()]
    .map(([label, prob]) => {
      const [a, b] = label.split('-').map(Number);
      return { label, a, b, prob, winner: a > b ? 'A' : 'B' };
    })
    .sort((x, y) => y.prob - x.prob);

  const aWins = scores.reduce((sum, s) => (s.winner === 'A' ? sum + s.prob : sum), 0);

  return {
    scores,
    aWins,
    // Точный счёт первого сета — отдельный ходовой рынок.
    firstSet: byServer[String(aServesFirst)].scores,
  };
}
