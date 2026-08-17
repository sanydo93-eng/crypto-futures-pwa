/**
 * Сила команд в атаке и обороне, отдельно для матча целиком и для первого тайма.
 *
 * Первый тайм считается по собственным данным первых таймов, а не как доля от
 * матча. Это принципиально: голы распределены по таймам неравномерно — во втором
 * их заметно больше, и «половина от матча» смещает оценку сразу на несколько
 * процентов на самом ходовом рынке.
 */

import { readFile } from 'node:fs/promises';

const PERIODS = ['full', 'firstHalf'];

function emptyTeam() {
  return {
    home: { matches: 0, scored: 0, conceded: 0, scored1H: 0, conceded1H: 0 },
    away: { matches: 0, scored: 0, conceded: 0, scored1H: 0, conceded1H: 0 },
    goalIn1H: 0,
    matches: 0,
  };
}

/**
 * Сглаживание к среднему по лиге: команда с тремя сыгранными матчами не должна
 * получать рейтинг атаки 2.0 из-за одного разгрома. prior — сколько матчей
 * «по среднему уровню лиги» подмешивается к наблюдениям.
 */
const smoothRate = (total, matches, leagueAverage, prior) =>
  (total + prior * leagueAverage) / (matches + prior);

export class TeamStrengths {
  constructor(data) {
    this.league = data.league;
    this.teams = new Map(Object.entries(data.teams));
    this.prior = data.prior ?? 6;
    this.generatedAt = data.generatedAt ?? null;
    this.competition = data.competition ?? null;
    this.sampleMatches = data.sampleMatches ?? null;
  }

  /** Возвращает null, если справочник ещё не собран — вызывающий решает, что делать. */
  static async load(path) {
    try {
      return new TeamStrengths(JSON.parse(await readFile(path, 'utf8')));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  toJSON() {
    return {
      generatedAt: this.generatedAt,
      competition: this.competition,
      league: this.league,
      prior: this.prior,
      sampleMatches: this.sampleMatches,
      teams: Object.fromEntries(this.teams),
    };
  }

  get size() {
    return this.teams.size;
  }

  has(name) {
    return this.teams.has(name);
  }

  /**
   * Ожидаемые голы в матче.
   * @param {'full'|'firstHalf'} period
   */
  expectedGoals(homeName, awayName, period = 'firstHalf') {
    const league = this.league[period];
    const home = this.teams.get(homeName);
    const away = this.teams.get(awayName);

    // Неизвестная команда получает средний уровень лиги — модель тогда
    // не увидит перекоса и не выдаст ложного преимущества.
    if (!home || !away) {
      return { lambdaHome: league.home, lambdaAway: league.away, known: false };
    }

    const key = period === 'firstHalf' ? '1H' : '';
    const prior = this.prior;

    // Дома команда забивает на уровне league.home и пропускает на уровне
    // league.away — к этим величинам и стягиваются наблюдения. В гостях наоборот.
    const homeScored = smoothRate(home.home[`scored${key}`], home.home.matches, league.home, prior);
    const homeConceded = smoothRate(home.home[`conceded${key}`], home.home.matches, league.away, prior);
    const awayScored = smoothRate(away.away[`scored${key}`], away.away.matches, league.away, prior);
    const awayConceded = smoothRate(away.away[`conceded${key}`], away.away.matches, league.home, prior);

    const homeAttack = homeScored / league.home;
    const homeDefence = homeConceded / league.away;
    const awayAttack = awayScored / league.away;
    const awayDefence = awayConceded / league.home;

    return {
      lambdaHome: league.home * homeAttack * awayDefence,
      lambdaAway: league.away * awayAttack * homeDefence,
      known: true,
      ratings: { homeAttack, homeDefence, awayAttack, awayDefence },
    };
  }

  /** Таблица для раздела статистики. */
  table() {
    return [...this.teams.entries()]
      .map(([name, team]) => {
        const matches = team.matches || 1;
        const scored1H = team.home.scored1H + team.away.scored1H;
        const conceded1H = team.home.conceded1H + team.away.conceded1H;

        return {
          name,
          matches: team.matches,
          scored: team.home.scored + team.away.scored,
          conceded: team.home.conceded + team.away.conceded,
          scored1H,
          conceded1H,
          goalsPerMatch: (team.home.scored + team.away.scored) / matches,
          goals1HPerMatch: (scored1H + conceded1H) / matches,
          // Доля матчей, где в первом тайме был хотя бы один гол —
          // эмпирическая проверка модели на том же рынке.
          goalIn1HShare: team.goalIn1H / matches,
        };
      })
      .sort((a, b) => b.goalIn1HShare - a.goalIn1HShare);
  }
}

/**
 * Сборка рейтингов из списка сыгранных матчей.
 * @param {Array<{home:string, away:string, hg:number, ag:number, hthg:number, htag:number}>} matches
 */
export function buildStrengths(matches, options = {}) {
  const { prior = 6, competition = null } = options;
  const teams = new Map();

  const totals = {
    full: { home: 0, away: 0 },
    firstHalf: { home: 0, away: 0 },
    matches: 0,
  };

  for (const m of matches) {
    if (![m.hg, m.ag, m.hthg, m.htag].every((v) => Number.isFinite(v) && v >= 0)) continue;
    // Голы первого тайма не могут превышать итоговые — защита от битых строк.
    if (m.hthg > m.hg || m.htag > m.ag) continue;

    for (const name of [m.home, m.away]) {
      if (!teams.has(name)) teams.set(name, emptyTeam());
    }

    const home = teams.get(m.home);
    const away = teams.get(m.away);

    home.home.matches += 1;
    home.home.scored += m.hg;
    home.home.conceded += m.ag;
    home.home.scored1H += m.hthg;
    home.home.conceded1H += m.htag;

    away.away.matches += 1;
    away.away.scored += m.ag;
    away.away.conceded += m.hg;
    away.away.scored1H += m.htag;
    away.away.conceded1H += m.hthg;

    const hadGoal = m.hthg + m.htag > 0 ? 1 : 0;
    home.goalIn1H += hadGoal;
    away.goalIn1H += hadGoal;
    home.matches += 1;
    away.matches += 1;

    totals.full.home += m.hg;
    totals.full.away += m.ag;
    totals.firstHalf.home += m.hthg;
    totals.firstHalf.away += m.htag;
    totals.matches += 1;
  }

  if (totals.matches === 0) {
    throw new Error('buildStrengths: не набралось ни одного пригодного матча');
  }

  const league = Object.fromEntries(
    PERIODS.map((period) => [
      period,
      {
        home: totals[period].home / totals.matches,
        away: totals[period].away / totals.matches,
      },
    ]),
  );

  return new TeamStrengths({
    league,
    prior,
    competition,
    generatedAt: new Date().toISOString(),
    teams: Object.fromEntries(teams),
    sampleMatches: totals.matches,
  });
}
