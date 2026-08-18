import { scoreGrid } from './poisson.js';

/**
 * Рынки первого тайма, выведенные из совместного распределения счёта.
 *
 * Каждый рынок — полный набор взаимоисключающих исходов, иначе снятие маржи
 * посчитает не то.
 */

const round = (value) => Number(value.toFixed(12));

/**
 * Свод по совместному распределению счёта. Механика одна и для тайма, и для
 * матча целиком — различаются только ожидаемые голы, поэтому разбор общий.
 */
function summarize(grid, maxGoals, exactLimit) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let homeScores = 0;
  let awayScores = 0;
  const totalGoals = new Map();
  const exact = [];

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = grid[h][a];
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;

      if (h > 0) homeScores += p;
      if (a > 0) awayScores += p;

      totalGoals.set(h + a, (totalGoals.get(h + a) ?? 0) + p);
      if (h <= exactLimit && a <= exactLimit) exact.push({ outcome: `${h}-${a}`, prob: p });
    }
  }

  const atLeast = (n) => {
    let sum = 0;
    for (const [goals, p] of totalGoals) if (goals >= n) sum += p;
    return sum;
  };

  // Обе забьют: дополнение к объединению «хозяева всухую» и «гости всухую».
  const btts = homeScores + awayScores - (1 - grid[0][0]);

  return { homeWin, draw, awayWin, atLeast, exact, btts, noGoal: grid[0][0] };
}

const totalLine = (atLeast, line) => {
  const over = atLeast(Math.ceil(line));
  return { over: round(over), under: round(1 - over) };
};

/** Рынки матча целиком: исход, тоталы, обе забьют, точный счёт. */
export function fullMatchMarkets(lambdaHome, lambdaAway, options = {}) {
  const { grid, maxGoals } = scoreGrid(lambdaHome, lambdaAway, { maxGoals: 10, ...options });
  const { homeWin, draw, awayWin, atLeast, exact, btts } = summarize(grid, maxGoals, 4);

  return {
    lambdaHome,
    lambdaAway,
    expectedGoals: lambdaHome + lambdaAway,
    result: { '1': round(homeWin), X: round(draw), '2': round(awayWin) },
    total15: totalLine(atLeast, 1.5),
    total25: totalLine(atLeast, 2.5),
    total35: totalLine(atLeast, 3.5),
    btts: { yes: round(btts), no: round(1 - btts) },
    exactScore: exact.sort((x, y) => y.prob - x.prob).map((e) => ({ ...e, prob: round(e.prob) })),
  };
}

export function firstHalfMarkets(lambdaHome, lambdaAway, options = {}) {
  const { grid, maxGoals } = scoreGrid(lambdaHome, lambdaAway, options);

  const noGoal = grid[0][0];
  const { homeWin, draw, awayWin, atLeast, exact } = summarize(grid, maxGoals, 3);

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
export function marketProbabilities(markets, full = null) {
  const probabilities = {
    firstHalfGoal: markets.goal,
    firstHalfTotal15: markets.total15,
    firstHalfResult: markets.result,
    firstHalfScore: Object.fromEntries(markets.exactScore.map((e) => [e.outcome, e.prob])),
  };

  // Рынки матча целиком: их отдают бесплатные источники, в отличие от таймовых.
  if (full) {
    Object.assign(probabilities, {
      matchResult: full.result,
      matchTotal15: full.total15,
      matchTotal25: full.total25,
      matchTotal35: full.total35,
      matchBtts: full.btts,
      matchScore: Object.fromEntries(full.exactScore.map((e) => [e.outcome, e.prob])),
    });
  }
  return probabilities;
}
