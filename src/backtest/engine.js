import { serveProbabilities, SURFACE_BASELINE } from '../tennis/serve.js';
import { matchDistribution } from '../tennis/match.js';
import { shrink } from '../tennis/stats.js';
import { parseScore, fromPerspectiveOfA, isPlausible } from './score.js';

const DAY = 86_400_000;

/**
 * Накопление статистики по ходу времени.
 *
 * Главное требование бэктеста — отсутствие заглядывания вперёд. Матч сначала
 * прогнозируется по тому, что известно строго до него, и только потом идёт в
 * копилку. Иначе метрики получаются прекрасными и полностью фиктивными.
 *
 * Вес старых матчей убывает экспоненциально: форма игрока меняется, и матч
 * трёхлетней давности не должен весить столько же, сколько прошлонедельный.
 */
export class RollingStats {
  constructor({ halfLifeDays = 365, prior = 20 } = {}) {
    this.halfLifeDays = halfLifeDays;
    this.prior = prior;
    this.players = new Map();
  }

  #key(name, surface) {
    return `${name}|${surface}`;
  }

  #tally(name, surface) {
    const key = this.#key(name, surface);
    if (!this.players.has(key)) {
      this.players.set(key, {
        // count — сколько матчей сыграно на самом деле, weight — их суммарный
        // вес после затухания. Первое отвечает на вопрос «есть ли история»,
        // второе — «насколько ей верить». Смешивать их нельзя: затухший
        // счётчик никогда не дотянет до целого порога.
        spWon: 0, sp: 0, rpWon: 0, rp: 0, weight: 0, count: 0, updatedAt: null,
      });
    }
    return this.players.get(key);
  }

  /** Приведение накопленных сумм к моменту времени. */
  #decay(tally, at) {
    if (!tally.updatedAt || !(this.halfLifeDays > 0)) return tally;

    const days = (at - tally.updatedAt) / DAY;
    if (!(days > 0)) return tally;

    const factor = 2 ** (-days / this.halfLifeDays);
    tally.spWon *= factor;
    tally.sp *= factor;
    tally.rpWon *= factor;
    tally.rp *= factor;
    tally.weight *= factor;
    tally.updatedAt = at;
    return tally;
  }

  /**
   * Оценка на момент `at`. Возвращает null, если наблюдений слишком мало —
   * прогноз по пустой статистике не отличается от подбрасывания монеты и
   * только зашумляет метрики.
   */
  estimate(name, surface, at, { baseline, minMatches = 5 }) {
    const tally = this.#decay(this.#tally(name, surface), at);
    if (tally.count < minMatches || tally.sp === 0 || tally.rp === 0) return null;

    return {
      spw: shrink(tally.spWon / tally.sp, tally.weight, baseline, this.prior),
      rpw: shrink(tally.rpWon / tally.rp, tally.weight, 1 - baseline, this.prior),
      matches: tally.count,
      weight: tally.weight,
    };
  }

  observe(name, surface, at, sample) {
    const tally = this.#decay(this.#tally(name, surface), at);
    tally.spWon += sample.spWon;
    tally.sp += sample.sp;
    tally.rpWon += sample.rpWon;
    tally.rp += sample.rp;
    tally.weight += 1;
    tally.count += 1;
    tally.updatedAt = at;
  }
}

/* ------------------------------------------------------------------ */

const toMap = (items, keyFn) =>
  Object.fromEntries(items.map((item) => [keyFn(item), item.prob]));

function average(first, second) {
  const merged = {};
  for (const key of new Set([...Object.keys(first), ...Object.keys(second)])) {
    merged[key] = ((first[key] ?? 0) + (second[key] ?? 0)) / 2;
  }
  return merged;
}

/**
 * Прогноз по матчу.
 *
 * Кто подаёт первым, в архиве не записано, а на распределение счёта это влияет
 * заметно. Поэтому берётся смесь двух вариантов в равных долях — честнее, чем
 * молча предположить один из них.
 */
export function predictMatch(a, b, { tour, surface, bestOf, baseline }) {
  const { pA, pB } = serveProbabilities(a, b, { tour, surface, baseline });

  const aFirst = matchDistribution(pA, pB, { bestOf, aServesFirst: true });
  const bFirst = matchDistribution(pA, pB, { bestOf, aServesFirst: false });

  return {
    pA,
    pB,
    aWins: (aFirst.aWins + bFirst.aWins) / 2,
    matchScores: average(toMap(aFirst.scores, (s) => s.label), toMap(bFirst.scores, (s) => s.label)),
    firstSetScores: average(
      toMap(aFirst.firstSet, (s) => `${s.a}-${s.b}`),
      toMap(bFirst.firstSet, (s) => `${s.a}-${s.b}`),
    ),
  };
}

/* ------------------------------------------------------------------ */

/**
 * Прогон по времени.
 *
 * @param {Array} matches матчи с полями date, winner, loser, score, статистикой подачи
 * @param {object} options
 */
export function runBacktest(matches, options = {}) {
  const {
    halfLifeDays = 365,
    prior = 20,
    minMatches = 5,
    baselines = null,
  } = options;

  const stats = new RollingStats({ halfLifeDays, prior });
  const ordered = [...matches].sort((x, y) => x.date - y.date);

  const predictions = { matchWinner: [], matchScore: [], firstSetScore: [] };
  const counters = { total: ordered.length, predicted: 0, skippedScore: 0, skippedStats: 0 };

  for (const match of ordered) {
    const sets = parseScore(match.score);
    const bestOf = match.bestOf ?? 3;

    if (!sets || !isPlausible(sets, bestOf)) {
      counters.skippedScore += 1;
      continue;
    }

    const surface = match.surface;
    const baseline = baselines?.[match.tour]?.[surface]
      ?? SURFACE_BASELINE[match.tour]?.[surface]
      ?? SURFACE_BASELINE.atp.hard;

    // Сторона A выбирается по алфавиту, а не «победитель первым» — иначе
    // игрок A выигрывает всегда и калибровка вырождается.
    const aIsWinner = match.winner.localeCompare(match.loser) <= 0;
    const nameA = aIsWinner ? match.winner : match.loser;
    const nameB = aIsWinner ? match.loser : match.winner;

    const estimateA = stats.estimate(nameA, surface, match.date, { baseline, minMatches });
    const estimateB = stats.estimate(nameB, surface, match.date, { baseline, minMatches });

    if (estimateA && estimateB) {
      const forecast = predictMatch(estimateA, estimateB, {
        tour: match.tour,
        surface,
        bestOf,
        baseline,
      });
      const actual = fromPerspectiveOfA(sets, aIsWinner);

      predictions.matchWinner.push({ p: forecast.aWins, outcome: actual.aWon ? 1 : 0 });
      predictions.matchScore.push({ probs: forecast.matchScores, actual: actual.label });
      if (actual.firstSet) {
        predictions.firstSetScore.push({
          probs: forecast.firstSetScores,
          actual: actual.firstSet,
        });
      }
      counters.predicted += 1;
    } else {
      counters.skippedStats += 1;
    }

    // Наблюдение добавляется строго после прогноза.
    if (match.serve) {
      stats.observe(match.winner, surface, match.date, match.serve.winner);
      stats.observe(match.loser, surface, match.date, match.serve.loser);
    }
  }

  return { predictions, counters };
}
