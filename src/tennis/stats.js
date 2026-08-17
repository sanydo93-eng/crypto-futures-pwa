import { readFile } from 'node:fs/promises';
import { SURFACE_BASELINE } from './serve.js';

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
    // Ключ — нормализованное имя, но исходное написание сохраняем для показа.
    this.players = new Map(
      Object.entries(data.players ?? {}).map(([name, stats]) => [
        normalizeName(name),
        { name, ...stats },
      ]),
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
   * Таблица для раздела статистики: сырые наблюдения без усадки, чтобы было
   * видно и саму величину, и размер выборки, на которой она получена.
   */
  table({ query = '', tour = null, surface = null, limit = 200 } = {}) {
    const needle = normalizeName(query);

    return [...this.players.entries()]
      .filter(([key, record]) => {
        if (tour && record.tour !== tour) return false;
        return !needle || key.includes(needle);
      })
      .map(([, record]) => {
        const source = (surface && record.surfaces?.[surface]) || record.overall;
        return {
          name: record.name ?? null,
          tour: record.tour,
          spw: source?.spw ?? null,
          rpw: source?.rpw ?? null,
          matches: source?.matches ?? 0,
          // Суммарный показатель: насколько игрок сильнее среднего в сумме
          // подачи и приёма. Именно он и двигает модель.
          combined: source ? source.spw + source.rpw : null,
        };
      })
      .filter((row) => row.matches > 0)
      .sort((a, b) => b.combined - a.combined)
      .slice(0, limit);
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
