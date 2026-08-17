/**
 * Разбор строки счёта из архива результатов.
 *
 * Формат Сакманна: счёт записан со стороны победителя, тай-брейки в скобках.
 *   «6-4 7-6(3)»        -> [[6,4],[7,6]]
 *   «4-6 6-3 2-1 RET»   -> null, матч не доигран
 */

const SET_TOKEN = /^(\d{1,2})-(\d{1,2})(?:\((\d+)\))?$/;
const UNFINISHED = /ret|w\/o|def|abn|walkover|unfinished|abandoned/i;

/** @returns {Array<[number, number]>|null} сеты со стороны победителя */
export function parseScore(raw) {
  const text = String(raw ?? '').trim();
  if (!text || UNFINISHED.test(text)) return null;

  const sets = [];
  for (const token of text.split(/\s+/)) {
    const match = token.match(SET_TOKEN);
    // Неразобранный кусок означает нестандартную запись — такой матч
    // безопаснее пропустить, чем угадывать.
    if (!match) return null;
    sets.push([Number(match[1]), Number(match[2])]);
  }

  return sets.length ? sets : null;
}

/**
 * Приведение к стороне игрока A.
 *
 * В архиве всё записано от победителя, а модели нужна фиксированная сторона —
 * иначе игрок A всегда побеждает и любая проверка калибровки бессмысленна.
 *
 * @param {Array<[number, number]>} sets сеты со стороны победителя
 * @param {boolean} aIsWinner
 */
export function fromPerspectiveOfA(sets, aIsWinner) {
  const oriented = aIsWinner ? sets : sets.map(([w, l]) => [l, w]);

  let setsA = 0;
  let setsB = 0;
  for (const [a, b] of oriented) {
    if (a > b) setsA += 1;
    else setsB += 1;
  }

  return {
    sets: oriented,
    label: `${setsA}-${setsB}`,
    firstSet: oriented[0] ? `${oriented[0][0]}-${oriented[0][1]}` : null,
    aWon: setsA > setsB,
  };
}

/** Счёт по сетам должен соответствовать формату матча. */
export function isPlausible(sets, bestOf) {
  const needed = Math.ceil(bestOf / 2);
  if (sets.length < needed || sets.length > bestOf) return false;

  let winner = 0;
  let loser = 0;
  for (const [w, l] of sets) {
    if (w > l) winner += 1;
    else loser += 1;
  }
  return winner === needed && loser < needed;
}
