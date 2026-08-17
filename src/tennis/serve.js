/**
 * Базовые уровни выигранных очков на подаче по покрытиям.
 *
 * ВАЖНО: это разумные стартовые значения, а не истина. Перед боевым
 * использованием пересчитай их на актуальных данных:
 *   node scripts/calibrate.js --tour atp --surface hard
 * Смещённый базовый уровень смещает всю модель, а на точном счёте это
 * дорого стоит.
 */
export const SURFACE_BASELINE = {
  atp: { hard: 0.645, clay: 0.62, grass: 0.665, carpet: 0.66 },
  wta: { hard: 0.565, clay: 0.55, grass: 0.585, carpet: 0.58 },
};

const clamp = (x, lo = 0.3, hi = 0.9) => Math.min(hi, Math.max(lo, x));

/**
 * Оценка вероятностей выигрыша очка на подаче для конкретной пары.
 *
 * Аддитивная модель Klaassen & Magnus: сила подачи игрока и сила приёма
 * соперника складываются как отклонения от среднего по туру.
 *
 *   p(A подаёт) = base + (подача A - base) - (приём B - (1 - base))
 *
 * @param {{spw:number, rpw:number}} a доли выигранных очков на подаче и на приёме
 * @param {{spw:number, rpw:number}} b
 * @param {{tour?: 'atp'|'wta', surface?: string}} context
 */
export function serveProbabilities(a, b, context = {}) {
  const { tour = 'atp', surface = 'hard' } = context;
  const base = SURFACE_BASELINE[tour]?.[surface] ?? SURFACE_BASELINE.atp.hard;
  const baseReturn = 1 - base;

  return {
    pA: clamp(base + (a.spw - base) - (b.rpw - baseReturn)),
    pB: clamp(base + (b.spw - base) - (a.rpw - baseReturn)),
    baseline: base,
  };
}
