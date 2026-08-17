import { scoreGrid } from './poisson.js';

/**
 * Рынки первого тайма, выведенные из совместного распределения счёта.
 *
 * Каждый рынок — полный набор взаимоисключающих исходов, иначе снятие маржи
 * посчитает не то.
 */

const round = (value) => Number(value.toFixed(12));

export function firstHalfMarkets(lambdaHome, lambdaAway, options = {}) {
  const { grid, maxGoals } = scoreGrid(lambdaHome, lambdaAway, options);

  let noGoal = grid[0][0];
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  const totalGoals = new Map();
  const exact = [];

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = grid[h][a];
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;

      totalGoals.set(h + a, (totalGoals.get(h + a) ?? 0) + p);
      if (h <= 3 && a <= 3) exact.push({ outcome: `${h}-${a}`, prob: p });
    }
  }

  const atLeast = (n) => {
    let sum = 0;
    for (const [goals, p] of totalGoals) if (goals >= n) sum += p;
    return sum;
  };

  const over05 = 1 - noGoal;
  const over15 = atLeast(2);
  const over25 = atLeast(3);

  return {
    lambdaHome,
    lambdaAway,
    expectedGoals: lambdaHome + lambdaAway,
    noGoal: round(noGoal),
    // Ключевой рынок: будет ли гол в первом тайме.
    goal: {
      yes: round(over05),
      no: round(noGoal),
    },
    total15: { over: round(over15), under: round(1 - over15) },
    total25: { over: round(over25), under: round(1 - over25) },
    result: { '1': round(homeWin), X: round(draw), '2': round(awayWin) },
    exactScore: exact.sort((x, y) => y.prob - x.prob).map((e) => ({ ...e, prob: round(e.prob) })),
  };
}

/** Вероятности по рынкам в виде, пригодном для сравнения с котировками. */
export function marketProbabilities(markets) {
  return {
    firstHalfGoal: markets.goal,
    firstHalfTotal15: markets.total15,
    firstHalfResult: markets.result,
    firstHalfScore: Object.fromEntries(markets.exactScore.map((e) => [e.outcome, e.prob])),
  };
}
