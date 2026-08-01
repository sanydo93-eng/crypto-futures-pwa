#!/usr/bin/env bash
# One-shot deploy for the signal bot. Run on the server from the repo root.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден. Установи его: curl -fsSL https://get.docker.com | sh" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "docker compose не найден. Установи плагин docker-compose-plugin." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "Создан .env из шаблона. Заполни TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID, потом запусти ./deploy.sh снова." >&2
  exit 1
fi

chmod 600 .env

for key in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
  value="$(grep -E "^${key}=" .env | head -n1 | cut -d= -f2- || true)"
  if [[ -z "${value}" ]]; then
    echo "В .env не заполнен ${key}" >&2
    exit 1
  fi
done

echo "==> Сборка образа"
"${COMPOSE[@]}" build

echo "==> Запуск"
"${COMPOSE[@]}" up -d

echo "==> Статус"
"${COMPOSE[@]}" ps

cat <<'EOF'

Готово. Полезные команды:
  docker compose logs -f          # смотреть логи
  docker compose restart          # перезапуск после правки .env
  docker compose down             # остановить
EOF
