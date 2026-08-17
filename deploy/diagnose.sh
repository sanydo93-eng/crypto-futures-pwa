#!/usr/bin/env bash
# Диагностика доступа к приложению на порту 8100.
# Запускать НА САМОМ СЕРВЕРЕ (5.10.218.52), под root или через sudo:
#   bash deploy/diagnose.sh
set -uo pipefail

PORT="${PORT:-8100}"

hr() { printf '\n=== %s ===\n' "$1"; }

hr "1. Слушает ли что-нибудь порт $PORT и на каком интерфейсе"
if command -v ss >/dev/null 2>&1; then
  ss -tlnp | grep -E ":${PORT}\b" || echo "НИЧЕГО не слушает порт ${PORT} — приложение не запущено."
else
  netstat -tlnp 2>/dev/null | grep -E ":${PORT}\b" || echo "НИЧЕГО не слушает порт ${PORT}."
fi
echo
echo "Как читать: '127.0.0.1:${PORT}' => доступ ТОЛЬКО локально (это и есть причина, если так)."
echo "            '0.0.0.0:${PORT}' или '*:${PORT}' => слушает наружу, проблема не в биндинге."

hr "2. Отвечает ли приложение локально"
curl -sS -o /dev/null -w 'localhost: code=%%{http_code}\n' --max-time 5 "http://127.0.0.1:${PORT}/" \
  || echo "localhost: приложение не отвечает"

hr "3. Отвечает ли по внешнему адресу с самого сервера"
EXT_IP="$(curl -sS --max-time 5 https://api.ipify.org 2>/dev/null || echo '')"
echo "Внешний IP сервера: ${EXT_IP:-не определён}"
if [ -n "$EXT_IP" ]; then
  curl -sS -o /dev/null -w "external: code=%%{http_code}\n" --max-time 5 "http://${EXT_IP}:${PORT}/" \
    || echo "external: не отвечает (блокирует firewall)"
fi

hr "4. Локальный firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw status verbose 2>/dev/null || true
fi
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --list-all 2>/dev/null || true
fi
echo "--- iptables INPUT ---"
iptables -L INPUT -n --line-numbers 2>/dev/null | head -40 || echo "iptables недоступен"
echo "--- nftables ---"
nft list ruleset 2>/dev/null | head -40 || echo "nft недоступен"

hr "5. Что слушает 80/443 (нужно для HTTPS)"
ss -tlnp 2>/dev/null | grep -E ':(80|443)\b' || echo "80 и 443 свободны — можно ставить Caddy/nginx."

hr "6. Docker (если приложение в контейнере)"
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}' 2>/dev/null || true
  echo "Проверь маппинг: должно быть 0.0.0.0:${PORT}->${PORT}/tcp, а НЕ 127.0.0.1:${PORT}->${PORT}/tcp"
else
  echo "docker не установлен"
fi

hr "ИТОГ"
cat <<'EOF'
Если п.1 показал 127.0.0.1  -> исправляй биндинг на 0.0.0.0 (см. deploy/README.md, раздел A).
Если п.1 показал 0.0.0.0, но п.3 не отвечает -> firewall (раздел B): локальный или в панели хостера.
Если п.3 отвечает, а с телефона нет -> это HTTPS/PWA либо блокировка порта у оператора (раздел C).
EOF
