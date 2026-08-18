const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 8100),
    host: env.HOST ?? '0.0.0.0', // наружу по умолчанию, иначе с телефона не открыть

    tennis: {
      provider: env.PROVIDER ?? 'mock',
      apiKey: env.API_TENNIS_KEY ?? '',
      statsPath: env.STATS_PATH ?? 'data/player-stats.json',
      // Поправка вероятностей, подобранная бэктестом:
      //   npm run backtest -- --save-calibration data/tennis-calibration.json
      calibrationPath: env.TENNIS_CALIBRATION_PATH ?? 'data/tennis-calibration.json',
    },
    football: {
      provider: env.FOOTBALL_PROVIDER ?? 'mock',
      statsPath: env.FOOTBALL_STATS_PATH ?? 'data/football-E0.json',
      betsapiToken: env.BETSAPI_TOKEN ?? '',
      // The Odds API: бесплатный тариф, 500 запросов в месяц.
      oddsApiKey: env.ODDS_API_KEY ?? '',
      oddsApiRegions: env.ODDS_API_REGIONS ?? 'eu',
      oddsApiLeagues: (env.ODDS_API_LEAGUES ?? 'soccer_epl')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      // Пустой список — брать все лиги. Обычно нужен фильтр: справочник
      // команд собирается по одной лиге, а BetsAPI отдаёт весь мир сразу.
      leagues: (env.BETSAPI_LEAGUES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      maxEvents: num(env.BETSAPI_MAX_EVENTS, 40),
    },

    cacheTtlMs: num(env.CACHE_TTL_MS, 120_000),
    scoring: {
      minEdge: num(env.MIN_EDGE, 0.05),
      minProbability: num(env.MIN_PROBABILITY, 0.02),
      devigMethod: env.DEVIG_METHOD ?? 'power',
      kellyFraction: num(env.KELLY_FRACTION, 0.25),
    },
  };
}
