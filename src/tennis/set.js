import { gameWinProbability } from './game.js';
import { tiebreakWinProbability } from './tiebreak.js';

/** Кто выиграл сет при таком счёте по геймам, или null если сет не окончен. */
function classify(ga, gb) {
  if (ga === 6 && gb <= 4) return 'A';
  if (gb === 6 && ga <= 4) return 'B';
  if (ga === 7 && (gb === 5 || gb === 6)) return 'A';
  if (gb === 7 && (ga === 5 || ga === 6)) return 'B';
  return null;
}

function accumulate(map, key, value) {
  map.set(key, (map.get(key) ?? 0) + value);
}

/**
 * Полное распределение по точному счёту в сете.
 *
 * Считается прямым динамическим программированием по состояниям «геймы A : геймы B».
 * Пространство состояний крошечное (максимум 7:6), поэтому перебор точный, без Монте-Карло.
 *
 * @param {number} pA вероятность A выиграть очко на своей подаче
 * @param {number} pB вероятность B выиграть очко на своей подаче
 * @param {{aServesFirst?: boolean, tiebreakTarget?: number}} options
 * @returns {{scores: Array<{a:number,b:number,winner:'A'|'B',prob:number,nextAServesFirst:boolean}>, aWins:number}}
 */
export function setDistribution(pA, pB, options = {}) {
  const { aServesFirst = true, tiebreakTarget = 7 } = options;

  const holdA = gameWinProbability(pA);
  const holdB = gameWinProbability(pB);

  // При 6:6 тай-брейк начинает тот, чья очередь подавать 13-й гейм.
  const tiebreakA = aServesFirst
    ? tiebreakWinProbability(pA, pB, tiebreakTarget)
    : 1 - tiebreakWinProbability(pB, pA, tiebreakTarget);

  // layers[n] — состояния, в которых сыграно n геймов. Максимум 13 геймов (7:6).
  const layers = Array.from({ length: 14 }, () => new Map());
  layers[0].set('0,0', 1);

  const scores = [];
  let aWins = 0;

  for (let played = 0; played < 14; played++) {
    for (const [key, prob] of layers[played]) {
      const [ga, gb] = key.split(',').map(Number);

      const winner = classify(ga, gb);
      if (winner) {
        // Следующий гейм имеет индекс ga+gb, подача чередуется непрерывно —
        // в том числе через тай-брейк, где первый подающий переходит на приём.
        const nextAServesFirst = (played % 2 === 0) === aServesFirst;
        scores.push({ a: ga, b: gb, winner, prob, nextAServesFirst });
        if (winner === 'A') aWins += prob;
        continue;
      }

      if (ga === 6 && gb === 6) {
        accumulate(layers[played + 1], '7,6', prob * tiebreakA);
        accumulate(layers[played + 1], '6,7', prob * (1 - tiebreakA));
        continue;
      }

      // Гейм с индексом played подаёт A, если чётность индекса совпадает
      // с тем, кто начинал сет.
      const aServesThisGame = (played % 2 === 0) === aServesFirst;
      const pAWinsGame = aServesThisGame ? holdA : 1 - holdB;

      accumulate(layers[played + 1], `${ga + 1},${gb}`, prob * pAWinsGame);
      accumulate(layers[played + 1], `${ga},${gb + 1}`, prob * (1 - pAWinsGame));
    }
  }

  scores.sort((x, y) => y.prob - x.prob);
  return { scores, aWins };
}
