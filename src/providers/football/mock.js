/**
 * Демо-провайдер футбола: фиксированные матчи без обращения к сети.
 *
 * Команды вымышленные. Ожидаемые голы заданы прямо, чтобы демо работало без
 * собранного справочника; в бою они считаются из рейтингов команд.
 * Коэффициенты выставлены с реальной маржой, кроме нескольких намеренно
 * завышенных исходов — на них и должны сработать сигналы.
 */

const FIXTURES = [
  {
    id: 'fb-demo-1',
    competition: 'Демо-лига, тур 12',
    home: 'Северный ФК',
    away: 'Приморье',
    startsAt: null,
    // Атакующая пара: гол в первом тайме почти в трёх матчах из четырёх.
    lambdaHome: 0.85,
    lambdaAway: 0.65,
    markets: {
      firstHalfGoal: { yes: 1.24, no: 4.0 },
      // Завышен исход over.
      firstHalfTotal15: { over: 2.55, under: 1.73 },
      firstHalfResult: { '1': 2.57, X: 2.4, '2': 3.78 },
      // Завышен счёт 1-1.
      firstHalfScore: {
        '0-0': 3.61, '1-0': 4.79, '1-1': 8.8, '0-1': 6.41,
        '2-0': 10.55, '2-1': 16.23, '0-2': 18.04, '1-2': 21.22,
        '3-0': 37.22, '2-2': 49.92, '3-1': 57.26, '0-3': 83.23,
        '1-3': 97.92, '3-2': 176.18, '2-3': 230.39, '3-3': 813.14,
      },
    },
  },
  {
    id: 'fb-demo-2',
    competition: 'Демо-лига, тур 12',
    home: 'Заречье',
    away: 'Горняк',
    startsAt: null,
    // Оборонительный матч: почти в половине случаев первый тайм без голов.
    lambdaHome: 0.5,
    lambdaAway: 0.38,
    markets: {
      // Завышен исход no.
      firstHalfGoal: { yes: 1.55, no: 2.6 },
      firstHalfTotal15: { over: 4.1, under: 1.22 },
      firstHalfResult: { '1': 3.3, X: 1.84, '2': 4.65 },
    },
  },
  {
    id: 'fb-demo-3',
    competition: 'Демо-кубок, 1/8 финала',
    home: 'Луговое',
    away: 'Верховина',
    startsAt: null,
    lambdaHome: 0.7,
    lambdaAway: 0.6,
    markets: {
      firstHalfGoal: { yes: 1.33, no: 3.3 },
      firstHalfTotal15: { over: 2.44, under: 1.53 },
      // Завышена ничья в первом тайме.
      firstHalfResult: { '1': 2.94, X: 2.75, '2': 3.64 },
    },
  },
];

export const name = 'football-mock';

export async function fetchFixtures() {
  return structuredClone(FIXTURES);
}

/* ------------------------------------------------------------------ */
/* Синтетическая история матчей для раздела статистики.                */
/* ------------------------------------------------------------------ */

const DEMO_TEAMS = [
  { name: 'Северный ФК', attack: 1.35, defence: 0.85 },
  { name: 'Приморье', attack: 1.15, defence: 1.05 },
  { name: 'Заречье', attack: 0.8, defence: 0.75 },
  { name: 'Горняк', attack: 0.75, defence: 0.95 },
  { name: 'Луговое', attack: 1.05, defence: 1.0 },
  { name: 'Верховина', attack: 0.95, defence: 1.1 },
  { name: 'Стрела', attack: 1.2, defence: 1.2 },
  { name: 'Дубрава', attack: 0.7, defence: 1.25 },
];

/** Детерминированный генератор: демо должно выглядеть одинаково при каждом запуске. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Метод Кнута: перемножаем равномерные, пока произведение не упадёт ниже e^-λ. */
function samplePoisson(lambda, random) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let product = random();
  while (product > limit) {
    k += 1;
    product *= random();
  }
  return k;
}

const LEAGUE_HOME = 1.5;
const LEAGUE_AWAY = 1.15;
// Доля голов, забиваемых до перерыва. Во втором тайме забивают заметно чаще —
// именно поэтому первый тайм нельзя считать половиной матча.
const FIRST_HALF_SHARE = 0.45;

/**
 * Двухкруговой турнир между демо-командами.
 * Голы первого тайма генерируются отдельно и прибавляются ко вторым,
 * поэтому итог никогда не может оказаться меньше счёта к перерыву.
 */
export function demoHistory(seed = 20260817) {
  const random = mulberry32(seed);
  const matches = [];

  for (const home of DEMO_TEAMS) {
    for (const away of DEMO_TEAMS) {
      if (home.name === away.name) continue;

      const lambdaHome = LEAGUE_HOME * home.attack * away.defence;
      const lambdaAway = LEAGUE_AWAY * away.attack * home.defence;

      const hthg = samplePoisson(lambdaHome * FIRST_HALF_SHARE, random);
      const htag = samplePoisson(lambdaAway * FIRST_HALF_SHARE, random);

      matches.push({
        home: home.name,
        away: away.name,
        hthg,
        htag,
        hg: hthg + samplePoisson(lambdaHome * (1 - FIRST_HALF_SHARE), random),
        ag: htag + samplePoisson(lambdaAway * (1 - FIRST_HALF_SHARE), random),
      });
    }
  }

  return matches;
}
