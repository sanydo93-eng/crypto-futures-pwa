const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 8100),
    host: env.HOST ?? '0.0.0.0', // наружу по умолчанию, иначе с телефона не открыть
    provider: env.PROVIDER ?? 'mock',
    apiKey: env.API_TENNIS_KEY ?? '',
    statsPath: env.STATS_PATH ?? 'data/player-stats.json',
    cacheTtlMs: num(env.CACHE_TTL_MS, 120_000),
    scoring: {
      minEdge: num(env.MIN_EDGE, 0.05),
      minProbability: num(env.MIN_PROBABILITY, 0.02),
      devigMethod: env.DEVIG_METHOD ?? 'power',
      kellyFraction: num(env.KELLY_FRACTION, 0.25),
    },
  };
}
