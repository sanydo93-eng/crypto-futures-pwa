#!/usr/bin/env bash
# Положить витрину туда, откуда её уже отдаёт работающий веб-сервер.
#
#   bash deploy/publish-static.sh
#
# Смысл: не открывать новый порт и не трогать firewall. Порт 80 у хостеров
# открыт почти всегда, и если на сервере уже крутится nginx/apache/caddy,
# достаточно положить файлы в его корень.
set -uo pipefail

cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib.sh"

SUDO="$(detect_sudo)"
SUBDIR="${1:-signals}"

hr()  { printf '\n=== %s\n' "$1"; }
say() { printf '  %s\n' "$1"; }

hr "1. Сборка витрины"
node scripts/build-static.js --single >/dev/null 2>&1 || {
  say "сборка не удалась — запусти вручную: node scripts/build-static.js"
  exit 1
}
say "готово: docs/"

hr "2. Ищу работающий веб-сервер"
SERVER=""
for name in nginx apache2 httpd caddy; do
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$name" 2>/dev/null; then
    SERVER="$name"
    break
  fi
done

if [ -n "$SERVER" ]; then
  say "работает: $SERVER"
else
  say "ни nginx, ни apache, ни caddy не запущены"
fi

# Корень выбираем существующий, а не первый попавшийся из списка.
ROOTDIR=""
for candidate in /var/www/html /usr/share/nginx/html /var/www /srv/http /usr/share/caddy; do
  [ -d "$candidate" ] && { ROOTDIR="$candidate"; break; }
done

hr "3. Куда класть"
if [ -z "$ROOTDIR" ]; then
  say "корень веб-сервера не найден."
  say ""
  say "Тогда два варианта:"
  say "  - отдать витрину самим приложением: оно уже раздаёт статику;"
  say "  - или поставить Caddy и проксировать порт 80:"
  say "      bash deploy/expose.sh --port80"
  exit 1
fi
say "корень: $ROOTDIR"

TARGET="${ROOTDIR}/${SUBDIR}"
$SUDO mkdir -p "$TARGET"
$SUDO cp -r docs/. "$TARGET"/
say "скопировано в $TARGET"

hr "4. Проверка"
LOCAL80="$(http_code "http://127.0.0.1/${SUBDIR}/")"
say "http://127.0.0.1/${SUBDIR}/ -> ${LOCAL80:-нет ответа}"

EXT="$(external_ip)"
if [ -n "$EXT" ]; then
  OUT="$(http_code "http://${EXT}/${SUBDIR}/")"
  say "http://${EXT}/${SUBDIR}/ -> ${OUT:-НЕТ ОТВЕТА}"

  hr "ИТОГ"
  if [ "$OUT" = "200" ]; then
    say "Открывай с телефона: http://${EXT}/${SUBDIR}/"
    say ""
    say "Это витрина: данные вшиты и не обновляются."
    say "Живые котировки — только через приложение на своём порту."
  else
    say "Снаружи не отвечает даже порт 80 — значит режет firewall хостера."
    say "Открой входящий TCP 80 в панели, и адрес заработает."
  fi
else
  say "внешний IP не определился"
fi
