import { readFile } from 'node:fs/promises';
import { SURFACE_BASELINE } from './model/serve.js';

/**
 * Справочник статистики игроков: доля выигранных очков на подаче и на приёме.
 *
 * Источник — исторические матчи (см. scripts/build-stats.js). Провайдеры
 * коэффициентов такую статистику обычно не отдают, поэтому она живёт отдельно.
 */

export const normalizeName = (name) =>
  String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // диакритика: Djokovic == Djoković
    .replace(/[.'`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Усадка к среднему по туру.
 *
 * У игрока с пятью матчами в выборке наблюдаемые 72% на подаче — это шум.
 * Формула тянет оценку к базовому уровню тем сильнее, чем меньше выборка;
 * prior задаёт, скольким матчам «равен по весу» базовый уровень.
 */
export function shrink(observed, sampleSize, baseline, prior = 20) {
  if (!Number.isFinite(observed) || sampleSize <= 0) return baseline;
  return (sampleSize * observed + prior * baseline) / (sampleSize + prior);
}

export class PlayerStats {
  constructor(data = { players: {} }) {
    this.data = data;
    this.players = new Map(
      Object.entries(data.players ?? {}).map(([name, stats]) => [normalizeName(name), stats]),
    );
  }

  static async load(path) {
    try {
      return new PlayerStats(JSON.parse(await readFile(path, 'utf8')));
    } catch (err) {
      if (err.code === 'ENOENT') return new PlayerStats();
      throw err;
    }
  }

  get size() {
    return this.players.size;
  }

  /**
   * Статистика игрока на покрытии, с усадкой к базовому уровню тура.
   * Для неизвестного игрока возвращается сам базовый уровень — модель
   * тогда сводится к «оба равны», и преимущества на таком матче не будет.
   */
  lookup(name, { tour = 'atp', surface = 'hard', prior = 20 } = {}) {
    const baseSpw = SURFACE_BASELINE[tour]?.[surface] ?? SURFACE_BASELINE.atp.hard;
    const baseRpw = 1 - baseSpw;

    const record = this.players.get(normalizeName(name));
    if (!record) {
      return { spw: baseSpw, rpw: baseRpw, matches: 0, known: false };
    }

    // Данные по покрытию точнее, но их меньше; общие — наоборот. Берём
    // покрытие, если выборка не совсем крошечная, иначе общие.
    const bySurface = record.surfaces?.[surface];
    const source = bySurface && bySurface.matches >= 5 ? bySurface : record.overall;
    if (!source) {
      return { spw: baseSpw, rpw: baseRpw, matches: 0, known: false };
    }

    return {
      spw: shrink(source.spw, source.matches, baseSpw, prior),
      rpw: shrink(source.rpw, source.matches, baseRpw, prior),
      matches: source.matches,
      known: true,
    };
  }
}
