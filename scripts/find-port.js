#!/usr/bin/env node
/**
 * Первый свободный порт, начиная с заданного.
 *
 *   node scripts/find-port.js 8100        # печатает 8100, или 8101, если занят
 *   node scripts/find-port.js 8100 --host 0.0.0.0
 *
 * Проверка — реальная привязка. Разбор вывода ss или netstat врёт: порт может
 * быть занят процессом в другом сетевом пространстве имён, а сами утилиты
 * на минимальном образе вообще отсутствуют.
 */
import { createServer } from 'node:net';

const args = process.argv.slice(2);
const start = Number(args.find((a) => /^\d+$/.test(a)) ?? 8100);
const hostIndex = args.indexOf('--host');
const host = hostIndex >= 0 ? args[hostIndex + 1] : '0.0.0.0';
const limit = 50;

if (!Number.isInteger(start) || start < 1 || start > 65535) {
  console.error(`Некорректный порт: ${start}`);
  process.exit(1);
}

const isFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });

for (let port = start; port < start + limit && port <= 65535; port++) {
  if (await isFree(port)) {
    process.stdout.write(String(port));
    process.exit(0);
  }
}

console.error(`Свободного порта не нашлось в диапазоне ${start}-${start + limit - 1}`);
process.exit(1);
