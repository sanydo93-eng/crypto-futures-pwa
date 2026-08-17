# Развёртывание с телефона через Termux

Доступа к твоему телефону и серверу у меня нет — я работаю в изолированном
контейнере без сети до них. Ниже команды, которые ты выполняешь сам.

## Установка Termux

Ставь **с F-Droid или из GitHub-релизов**, не из Play Market: версия в Play
заморожена с 2020 года, `pkg install` в ней ломается.

```bash
pkg update && pkg upgrade -y
pkg install -y openssh git nodejs-lts
```

---

## Вариант А: приложение прямо на телефоне

Самый быстрый путь, и у него есть неочевидное преимущество: **`localhost`
считается защищённым контекстом**. То есть service worker, офлайн-режим и
установка на домашний экран заработают без всякого HTTPS и без домена —
ровно то, что не получается при заходе на `http://5.10.218.52:8100`.

```bash
git clone https://github.com/sanydo93-eng/crypto-futures-pwa.git
cd crypto-futures-pwa
npm test          # 64 теста, зависимостей ставить не нужно
npm start
```

Открой в браузере телефона `http://localhost:8100`. Меню браузера →
«Установить приложение» — появится иконка на экране.

Ограничение: работает, пока Termux запущен. Чтобы Android не убивал процесс,
отключи для Termux оптимизацию батареи и включи wake-lock (уведомление Termux →
`Acquire wakelock`).

Данные для моделей:

```bash
node scripts/build-stats.js --from 2021 --to 2025          # теннис
node scripts/build-football-stats.js --league E0            # футбол
```

---

## Вариант Б: заливка на сервер по SSH

```bash
ssh-keygen -t ed25519                     # если ключа ещё нет
ssh-copy-id root@5.10.218.52              # один раз, дальше без пароля
ssh root@5.10.218.52
```

Дальше всё выполняется **на сервере**:

```bash
# Node 20+ (Debian/Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git

sudo mkdir -p /opt/signals && sudo chown $USER /opt/signals
git clone https://github.com/sanydo93-eng/crypto-futures-pwa.git /opt/signals
cd /opt/signals
npm test
```

Настройки и ключ:

```bash
cp .env.example .env
nano .env          # вписать API_TENNIS_KEY, PROVIDER=api-tennis
chmod 600 .env     # ключ не должен читаться другими пользователями
```

Проверить, что провайдер отвечает и разбор ответа не разъехался:

```bash
npm run probe
```

Собрать справочники и запустить как службу:

```bash
node scripts/build-stats.js --from 2021 --to 2025
node scripts/build-football-stats.js --league E0

sudo cp deploy/signals.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now signals
journalctl -u signals -f
```

Обновление после изменений в репозитории:

```bash
cd /opt/signals && git pull && npm test && sudo systemctl restart signals
```

---

## Обновление данных по расписанию

Коэффициенты приложение тянет само, а справочники статистики — нет.
Раз в неделю достаточно:

```bash
sudo crontab -e
```

```cron
0 5 * * 1 cd /opt/signals && node scripts/build-stats.js --from 2021 --to 2025 >> /var/log/signals-stats.log 2>&1
30 5 * * 1 cd /opt/signals && node scripts/build-football-stats.js --league E0 >> /var/log/signals-stats.log 2>&1
```

---

## Доступ с телефона

Порт и HTTPS разбираются в `deploy/README.md`. Коротко: приложение слушает
`0.0.0.0:8100`, для доступа снаружи нужно открыть порт в firewall сервера
**и** в панели хостера. Для установки на домашний экран через внешний адрес
нужен домен и HTTPS — конфиг Caddy лежит там же.

Если домена нет, а офлайн и иконка на экране нужны — вариант А выше даёт их
без всякого домена.
