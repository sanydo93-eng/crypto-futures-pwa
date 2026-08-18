#!/usr/bin/env bash
# Открыть доступ к приложению снаружи.
#
#   bash deploy/expose.sh            # открыть текущий порт и проверить
#   bash deploy/expose.sh --port80   # плюс поставить Caddy и отдавать на порту 80
#
# Порт 80 стоит того: часть мобильных операторов режет нестандартные порты,
# и адрес без номера порта телефон открывает надёжнее.
set -uo pipefail

cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib.sh"

USE_PORT80=0
[ "${1:-}" = "--port80" ] && USE_PORT80=1

SUDO="$(detect_sudo)"

hr()  { printf '\n=== %s\n' "$1"; }
say() { printf '  %s\n' "$1"; }

PORT="8100"
[ -f .env ] && PORT="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-8100}"

probe() { http_code "$1"; }

# ---------------------------------------------------------------------

hr "1. Приложение внутри сервера"
LOCAL="$(probe "http://127.0.0.1:${PORT}/api/health")"
say "127.0.0.1:${PORT} -> ${LOCAL:-нет ответа}"
if [ "$LOCAL" != "200" ]; then
  say "Приложение не отвечает даже локально — снаружи чинить нечего."
  say "Смотри: systemctl status signals; journalctl -u signals -n 50"
  exit 1
fi

hr "2. На каком интерфейсе слушает"
LISTEN="$(listen_addr "$PORT")"
case "$?" in
  0) say "$LISTEN" ;;
  1) say "порт не слушает никто (хотя локальный запрос прошёл — странно)" ;;
  2) say "проверить нечем: нет ни ss, ни netstat, ни /proc/net/tcp" ;;
esac

if is_loopback_only "$LISTEN"; then
  say "Слушает ТОЛЬКО localhost — снаружи не откроется. Правлю на 0.0.0.0."
  if grep -q '^HOST=' .env 2>/dev/null; then
    sed -i "s|^HOST=.*|HOST=0.0.0.0|" .env
  else
    echo "HOST=0.0.0.0" >> .env
  fi
  $SUDO systemctl restart signals 2>/dev/null && say "служба перезапущена" || say "перезапусти приложение вручную"
  sleep 2
fi

hr "3. Локальный firewall"
if command -v ufw >/dev/null 2>&1; then
  $SUDO ufw allow "${PORT}/tcp" >/dev/null 2>&1 && say "ufw: порт ${PORT} открыт"
  [ "$USE_PORT80" = 1 ] && $SUDO ufw allow 80/tcp >/dev/null 2>&1 && say "ufw: порт 80 открыт"
elif command -v firewall-cmd >/dev/null 2>&1; then
  $SUDO firewall-cmd --add-port="${PORT}/tcp" --permanent >/dev/null 2>&1
  [ "$USE_PORT80" = 1 ] && $SUDO firewall-cmd --add-port=80/tcp --permanent >/dev/null 2>&1
  $SUDO firewall-cmd --reload >/dev/null 2>&1 && say "firewalld: порты открыты"
else
  say "ufw и firewalld не найдены — локального firewall нет"
fi

# ---------------------------------------------------------------------

if [ "$USE_PORT80" = 1 ]; then
  hr "4. Порт 80"

  BUSY80="$(listen_addr 80)"
  PORT80_TAKEN=$?

  # Если 80-й свободен и мы можем на него сесть, прокси не нужен вовсе:
  # лишний слой — это лишняя точка отказа и лишний пакет для установки.
  if [ "$PORT80_TAKEN" -ne 0 ] && [ "$(id -u)" = "0" ]; then
    say "порт 80 свободен — переношу приложение прямо на него, без прокси"

    if grep -q '^PORT=' .env 2>/dev/null; then
      sed -i "s|^PORT=.*|PORT=80|" .env
    else
      echo "PORT=80" >> .env
    fi

    if systemctl restart signals 2>/dev/null; then
      say "служба перезапущена на порту 80"
    else
      say "перезапусти приложение вручную — оно теперь настроено на порт 80"
    fi

    sleep 2
    PORT=80
    USE_PORT80=0
    LOCAL80="$(http_code "http://127.0.0.1/api/health")"
    say "127.0.0.1:80 -> ${LOCAL80:-нет ответа}"
  fi

  # Занятый 80-й почти всегда означает уже работающий веб-сервер. Ставить
  # поверх него Caddy бессмысленно: он не поднимется, а причина будет неочевидна.
  if [ "$PORT80_TAKEN" -eq 0 ] && ! command -v caddy >/dev/null 2>&1; then
    say "порт 80 уже занят: $BUSY80"
    OWNER=""
    for name in nginx apache2 httpd; do
      systemctl is-active --quiet "$name" 2>/dev/null && OWNER="$name" && break
    done

    if [ -n "$OWNER" ]; then
      say "его держит $OWNER — Caddy туда не встанет."
      say ""
      say "Правильный путь: положить витрину в корень $OWNER одной командой:"
      say "  bash deploy/publish-static.sh"
      say ""
      say "Либо добавить в $OWNER проксирование на 127.0.0.1:${PORT} самому."
    else
      say "чем именно занят — неясно, но Caddy туда не встанет."
      say "Освободи порт 80 либо используй: bash deploy/publish-static.sh"
    fi
    USE_PORT80=0
  fi

  if [ "$USE_PORT80" = 1 ] && ! command -v caddy >/dev/null 2>&1; then
    say "ставлю Caddy"
    $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | $SUDO gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null 2>&1
    $SUDO apt-get update >/dev/null 2>&1
    $SUDO apt-get install -y caddy >/dev/null 2>&1 || { say "не удалось поставить Caddy"; USE_PORT80=0; }
  fi

  if [ "$USE_PORT80" = 1 ] && command -v caddy >/dev/null 2>&1; then
    EXT="$(external_ip)"
    # http:// в начале обязателен: иначе Caddy попробует взять сертификат на IP.
    printf 'http://%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "${EXT:-:80}" "$PORT" \
      | $SUDO tee /etc/caddy/Caddyfile >/dev/null
    $SUDO systemctl reload caddy 2>/dev/null || $SUDO systemctl restart caddy 2>/dev/null
    say "Caddy проксирует порт 80 на ${PORT}"
  fi
fi

# ---------------------------------------------------------------------

hr "5. Проверка снаружи"
EXT="$(external_ip)"
say "внешний IP: ${EXT:-не определён}"

if [ -z "$EXT" ]; then
  say "IP не определился — проверь сеть на сервере"
  exit 1
fi

if [ "$PORT" = "80" ]; then
  OUT="$(probe "http://${EXT}/api/health")"
  say "http://${EXT} -> ${OUT:-НЕТ ОТВЕТА}"
else
  OUT="$(probe "http://${EXT}:${PORT}/api/health")"
  say "http://${EXT}:${PORT} -> ${OUT:-НЕТ ОТВЕТА}"
fi

OUT80=""
if [ "$USE_PORT80" = 1 ]; then
  OUT80="$(probe "http://${EXT}/api/health")"
  say "http://${EXT} -> ${OUT80:-НЕТ ОТВЕТА}"
fi

# ---------------------------------------------------------------------

hr "ВЫВОД"
if [ "$OUT" = "200" ] || [ "$OUT80" = "200" ]; then
  ADDR="http://${EXT}:${PORT}"
  { [ "$OUT80" = "200" ] || [ "$PORT" = "80" ]; } && ADDR="http://${EXT}"

  say "Сервер отдаёт наружу. Открывай с телефона: $ADDR"
  say ""
  say "Если телефон всё равно не открывает — дело в браузере или операторе:"
  say "  1. Chrome -> Настройки -> Конфиденциальность и безопасность ->"
  say "     «Всегда использовать безопасные подключения» -> ВЫКЛЮЧИТЬ."
  say "     Иначе Chrome молча меняет http на https, где никто не слушает."
  say "  2. Проверь и по Wi-Fi, и по мобильному интернету. Разница = оператор"
  say "     режет порт; тогда запусти: bash deploy/expose.sh --port80"
else
  say "Снаружи не отвечает, хотя внутри сервера работает."
  say "Значит режет firewall ВЫШЕ уровнем — в панели хостера."
  say ""
  say "Открой там входящий TCP ${PORT}$([ "$USE_PORT80" = 1 ] && echo ' и 80')."
  say "Обычно это раздел Firewall / Security Group / Брандмауэр."
  say "По умолчанию у большинства хостеров открыты только 22, 80 и 443 —"
  say "поэтому вариант с портом 80 обходит проблему без панели:"
  say "  bash deploy/expose.sh --port80"
fi
