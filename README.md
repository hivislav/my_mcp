# open-meteo-mcp

MCP-сервер вокруг бесплатного API [Open-Meteo](https://open-meteo.com/): погода, прогноз, качество воздуха и геокодирование — как инструменты для ИИ-агента.

Сервер сразу спроектирован под выгрузку на VPS: два транспорта (stdio для локальной работы и Streamable HTTP для удалённого подключения), bearer-аутентификация, Docker/systemd/nginx-артефакты.

---

## Содержание

- [Что реализовано](#что-реализовано)
- [Требования](#требования)
- [Быстрый старт](#быстрый-старт)
- [Источник данных](#источник-данных)
- [Инструменты](#инструменты)
- [Как возвращается результат](#как-возвращается-результат)
- [Подключение к ИИ-агенту](#подключение-к-ии-агенту)
- [Выгрузка на VPS](#выгрузка-на-vps)
- [Переменные окружения](#переменные-окружения)
- [Структура проекта](#структура-проекта)
- [Тесты](#тесты)
- [Безопасность](#безопасность)
- [Известные ограничения](#известные-ограничения)

---

## Что реализовано

Три требования из задачи и то, как они закрыты:

| Требование | Реализация |
|---|---|
| **Регистрация инструмента** | `server.registerTool(name, config, handler)` в `src/tools/*.ts`; единая точка регистрации — `src/tools/index.ts`. Все 4 инструмента имеют `title`, `description` и `annotations` (`readOnlyHint`, `destructiveHint`). |
| **Описание входных параметров** | Схемы на Zod (`.describe()` на каждом поле) → SDK генерирует JSON Schema, которую видит модель. Проверяется тестом `documents every input parameter via the generated JSON Schema`. |
| **Возврат результата** | Каждый инструмент возвращает **одновременно** `content` (текст для модели) и `structuredContent` (типизированный JSON, валидируемый по `outputSchema`). |

Дополнительно, с прицелом на VPS:

- два транспорта — `stdio` и Streamable HTTP;
- stateless-режим по умолчанию (нет привязки к сессии → безопасны рестарты и горизонтальное масштабирование);
- bearer-аутентификация с сравнением за постоянное время;
- сервер **отказывается** слушать не-loopback адрес без токена;
- retry с экспоненциальным backoff, таймауты, типизированные ошибки;
- JSON-логи в stderr (stdout на stdio-транспорте занят протоколом);
- graceful shutdown по SIGTERM/SIGINT, `/healthz` для мониторинга;
- Dockerfile (multi-stage, non-root), docker-compose, systemd unit, пример nginx.

---

## Требования

- **Node.js ≥ 20** (используется глобальный `fetch` и `AbortSignal.any`). Проверено на Node 26.
- Исходящий HTTPS к `ensemble-api.open-meteo.com` (погода), `geocoding-api.open-meteo.com` (геокодирование) и `air-quality-api.open-meteo.com` (качество воздуха).
- API-ключ **не нужен** — тариф Open-Meteo бесплатный.

---

## Быстрый старт

```bash
npm install
npm run build

# локально, для отладки в MCP-инспекторе или агенте
npm start                       # stdio (по умолчанию)

# как сетевой сервис
MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm run start:http
# → http://127.0.0.1:3000/mcp
```

Проверка живости:

```bash
curl -s http://127.0.0.1:3000/healthz
```

Прогон «живых» вызовов против реального API (отдельно от герметичных тестов):

```bash
npm run smoke                                                    # через stdio
npm run smoke -- --url http://127.0.0.1:3000/mcp --token <TOKEN>  # через HTTP
```

`--help` печатает все флаги и переменные окружения:

```bash
node dist/index.js --help
```

---

## Источник данных

Погода берётся из Open-Meteo, но **не с классического хоста `api.open-meteo.com`**: его IP (`94.130.142.35`) недоступен с некоторых сетей — TCP-соединение просто уходит в таймаут, при этом все остальные хосты Open-Meteo отвечают нормально. Это проверено: DNS отдаёт корректный адрес (подтверждено через Cloudflare DoH), а контрольная загрузка файла на 928 КБ с другого хоста занимает 0,6 с — то есть дело не в сети целиком и не в коде.

Поэтому по умолчанию используется **`ensemble-api.open-meteo.com`**, который:

- отдаёт **ту же самую JSON-схему** — те же имена переменных, те же коды погоды WMO, те же единицы;
- доступен отовсюду;
- не требует ключа;
- даёт полный горизонт **16 суток** при `models=gfs05`.

Единственное отличие: в ансамблевом продукте нет `precipitation_probability`, поэтому это поле всегда `null`. В описании поля в схеме инструмента это указано явно, чтобы модель не приняла `null` за «осадков не будет».

### Два поддерживаемых режима

| | **A. Ансамблевый хост** (по умолчанию) | **B. Стандартный хост** (для VPS) |
|---|---|---|
| `OPEN_METEO_FORECAST_URL` | `https://ensemble-api.open-meteo.com` | `https://api.open-meteo.com` |
| `OPEN_METEO_FORECAST_PATH` | `/v1/ensemble` | `/v1/forecast` |
| `OPEN_METEO_MODELS` | `gfs05` | *(пусто)* |
| Горизонт прогноза | 16 суток | 16 суток |
| Вероятность осадков | ❌ `null` | ✅ есть |
| Доступность | отовсюду | зависит от сети |

Переключение на стандартный хост — это три переменные окружения, без правок кода:

```bash
export OPEN_METEO_FORECAST_URL=https://api.open-meteo.com
export OPEN_METEO_FORECAST_PATH=/v1/forecast
export OPEN_METEO_MODELS=          # пустое значение = не отправлять models вовсе
```

> **Почему `gfs05`.** Ансамблевый API требует явную модель и отклоняет `best_match`. Горизонт у моделей разный: `icon_seamless` и `icon_global` покрывают только 7 суток (дальше значения приходят `null`), `gfs025` — 10, `ecmwf_ifs025` — 14, и только `gfs05` даёт полные 16 суток вместе с УФ-индексом.

### Почему не wttr.in

Изначально рассматривался `https://wttr.in/api`, но:

1. **Такого эндпоинта не существует** — `/api` возвращает обычный текстовый отчёт для места с названием «api», а не JSON.
2. **Реальный JSON-эндпоинт `?format=j1` нерабочий.** Из 12 запросов (Москва, Лондон, Париж, Нью-Йорк, координаты; gzip и без; HTTP/1.1 и HTTP/2; таймауты до 150 с) **ни один** не вернул валидный JSON: ответ обрывается на 10665 или 13037 байт внутри блока `weatherIconUrl` и дальше висит. Это поведение самого wttr.in, а не сети — контрольная загрузка 928 КБ с GitHub проходит за 0,6 с.
3. Надёжно работают только текстовые форматы, а это означает отказ от прогноза, качества воздуха и геокодирования.

Если нужен независимый поставщик, проверенным запасным вариантом остаётся **MET Norway** (`api.met.no`, бесплатно, без ключа, глобально, ~10 суток): он тоже доступен с этой машины, но требует заголовок `User-Agent` (без него — 403) и отдаёт собственные коды символов вместо WMO. В текущей реализации он не подключён.

---

## Инструменты

### `geocode_location`

Превращает название места в координаты и метаданные.

| Параметр | Тип | Обяз. | Описание |
|---|---|---|---|
| `name` | string | да | Название места: `Moscow`, `Санкт-Петербург`. Без индекса и страны. |
| `count` | int 1–20 | нет | Сколько кандидатов вернуть. По умолчанию 5. |
| `language` | string | нет | ISO-639 код языка названий (`en`, `ru`). По умолчанию `en`. |
| `countryCode` | string(2) | нет | ISO-3166-1 alpha-2 для сужения поиска (`RU`, `US`). |

Возвращает координаты, страну, регион, таймзону, население и флаг `ambiguous` — он помогает агенту понять, что название неоднозначно («Springfield»).

### `get_current_weather`

Текущая погода: температура, «ощущается как», влажность, осадки, облачность, давление, ветер (скорость/направление/порывы), а также расшифрованный код погоды WMO.

Общие параметры локации (см. ниже) + `units`.

### `get_weather_forecast`

Прогноз по дням до 16 суток: min/max температура, «ощущается», сумма осадков, снег, УФ-индекс, восход/закат, максимум ветра. Опционально — почасовой ряд. Вероятность осадков зависит от источника данных (см. [Источник данных](#источник-данных)).

Общие параметры локации + `units`, плюс:

| Параметр | Тип | Обяз. | Описание |
|---|---|---|---|
| `days` | int 1–16 | нет | Число дней прогноза. По умолчанию 7. |
| `include_hourly` | bool | нет | Добавить почасовой ряд (ответ вырастает ~24×). По умолчанию false. |

### `get_air_quality`

Качество воздуха: PM2.5, PM10, O₃, NO₂, SO₂, CO, аммиак, пыль, УФ-индекс, европейский и американский индексы AQI, плюс расшифрованная категория опасности и рекомендация для здоровья.

Общие параметры локации.

### Общие параметры локации

Все три «погодных» инструмента принимают локацию **любым из двух способов** — это сделано специально, чтобы типовой запрос укладывался в один вызов инструмента:

| Параметр | Тип | Описание |
|---|---|---|
| `latitude` | number −90…90 | Широта. Указывать вместе с `longitude`. |
| `longitude` | number −180…180 | Долгота. Указывать вместе с `latitude`. |
| `location` | string | Название места — сервер сам его геокодирует и берёт самый населённый вариант. |
| `countryCode` | string(2) | Сужает геокодирование `location`. |
| `language` | string | Язык названия места. По умолчанию `en`. |
| `units` | `metric` \| `imperial` | Система единиц. По умолчанию `metric`. |

> Почему «или/или» не выражено в JSON Schema: MCP-клиенты показывают модели упрощённую JSON Schema, в которой взаимоисключение не выражается. Поэтому правило проверяется в коде, а ошибка возвращается **как текст с указанием, что именно исправить** — так модель самокорректируется, а не получает невнятный отказ.

---

## Как возвращается результат

Ответ каждого инструмента содержит два канала:

```jsonc
{
  "content": [
    { "type": "text", "text": "Current weather in Москва, Россия (55.75204, 37.61781)\n..." }
  ],
  "structuredContent": {
    "location": { "name": "Москва", "latitude": 55.75204, "longitude": 37.61781, "timezone": "Europe/Moscow" },
    "observed_at": "2026-09-25T15:00",
    "weather_code": 61,
    "condition": "slight_rain",
    "condition_en": "Slight rain",
    "condition_ru": "Небольшой дождь",
    "temperature": 12.4,
    "units": { "temperature": "°C", "wind_speed": "km/h", "precipitation": "mm" }
  }
}
```

- **`content`** — компактная сводка для человека и модели.
- **`structuredContent`** — те же данные как JSON, проверенные по `outputSchema` инструмента. Годится для расчётов и сравнений.

Особенности, важные для агента:

- **Единицы всегда возвращаются явно** в поле `units` — модель не должна угадывать.
- **Код погоды WMO расшифровывается** (`weather_code: 61` → `condition: "slight_rain"`, `condition_en`, `condition_ru`).
- **`hourly` равен `null`**, если почасовой ряд не запрашивали: так модель отличает «не просили» от «просили, но пусто».
- **Ошибки приходят как `isError: true` с текстом**, а не как обрыв транспорта: упоминается вид ошибки, HTTP-статус, причина от upstream и то, временная она или нет. Пример:
  `Open-Meteo request failed [network]: Could not reach ensemble-api.open-meteo.com: fetch failed. This looks transient — retrying may succeed.`
- Серверные исключения логируются целиком, но наружу отдаётся общее сообщение — стектрейсы не утекают удалённому агенту.

---

## Подключение к ИИ-агенту

### Вариант A. Локально через stdio

Клиент сам запускает процесс сервера. Подходит для Claude Desktop, IDE-агентов и DSH.

```bash
npm install && npm run build && npm link   # кладёт bin `open-meteo-mcp` в PATH
```

Обобщённая конфигурация (формат `mcpServers`, который понимают большинство клиентов):

```json
{
  "mcpServers": {
    "open_meteo": {
      "command": "open-meteo-mcp",
      "args": ["--transport", "stdio"],
      "env": { "LOG_LEVEL": "warn" }
    }
  }
}
```

**Готовый оверлей для DSH** лежит в `deploy/dsh-mcp-overlay.example.yml`:

```bash
dsh web --patch "$PWD/deploy/dsh-mcp-overlay.example.yml"
```

DSH публикует инструменты как `mcp__<serverName>__<tool>`, то есть в модели они видны так:

```
mcp__open_meteo__geocode_location
mcp__open_meteo__get_current_weather
mcp__open_meteo__get_weather_forecast
mcp__open_meteo__get_air_quality
```

> `serverName` должен соответствовать `[A-Za-z0-9_-]{1,32}` — точки и пробелы недопустимы.

### Вариант B. Удалённо через Streamable HTTP (то, что нужно для VPS)

1. Разверните сервер (см. ниже) и получите URL вида `https://mcp.example.com/mcp`.
2. Подключите агента, передав заголовок `Authorization: Bearer <TOKEN>`.

Обобщённая конфигурация:

```json
{
  "mcpServers": {
    "open_meteo": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${OPEN_METEO_MCP_TOKEN}" }
    }
  }
}
```

Для DSH — раскомментируйте «Option B» в `deploy/dsh-mcp-overlay.example.yml`; токен там читается из `process.env`, чтобы не хранить секрет в файле.

Проверка вручную, без агента:

```bash
curl -s https://mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

---

## Выгрузка на VPS

### Docker Compose (рекомендуется)

```bash
cp .env.example .env
# обязательно заполните MCP_AUTH_TOKEN:
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env

docker compose up -d --build
docker compose logs -f
```

Порт публикуется **только на loopback** (`127.0.0.1:3000`) — снаружи его закрывает reverse proxy с TLS.

Контейнер запускается non-root, с `read_only` rootfs, `cap_drop: ALL` и `no-new-privileges`.

### systemd (без Docker)

```bash
sudo useradd --system --home /opt/open-meteo-mcp --shell /usr/sbin/nologin mcp
sudo mkdir -p /opt/open-meteo-mcp
sudo rsync -a --delete dist/ node_modules/ package.json /opt/open-meteo-mcp/

sudo cp .env.example /etc/open-meteo-mcp.env
sudo chmod 600 /etc/open-meteo-mcp.env   # секреты — только root
sudo nano /etc/open-meteo-mcp.env        # впишите MCP_AUTH_TOKEN

sudo cp deploy/open-meteo-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now open-meteo-mcp
sudo systemctl status open-meteo-mcp
journalctl -u open-meteo-mcp -f
```

Юнит уже содержит хардненинг (`ProtectSystem=strict`, `PrivateTmp`, пустой `CapabilityBoundingSet` и т. д.).

### nginx + TLS

Шаблон: `deploy/nginx.conf.example`.

Ключевые моменты, без которых не заработает:

- проброс заголовка `Authorization` (`proxy_set_header Authorization $http_authorization;`);
- `proxy_buffering off;` — иначе SSE-поток Streamable HTTP будет забуферен;
- `proxy_read_timeout` больше, чем `OPEN_METEO_TIMEOUT_MS × (OPEN_METEO_MAX_RETRIES + 1)`;
- редирект с HTTP на HTTPS, чтобы токен не ушёл в открытом виде.

Так как сервер по умолчанию **stateless**, привязка сессий в upstream не нужна — можно поднять несколько реплик.

---

## Переменные окружения

Полный список — в `.env.example`. Главное:

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` или `http`. Флаг `--transport` имеет приоритет. |
| `MCP_HOST` | `127.0.0.1` | Адрес прослушивания. |
| `MCP_PORT` | `3000` | Порт. |
| `MCP_PATH` | `/mcp` | Путь эндпоинта. |
| `MCP_AUTH_TOKEN` | — | Bearer-токен. **Обязателен** для не-loopback адреса. |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | Явно разрешить публичный bind без токена. |
| `MCP_SESSION_MODE` | `stateless` | `stateless` или `stateful`. |
| `MCP_JSON_RESPONSE` | `true` | JSON-ответ вместо SSE. |
| `MCP_ALLOWED_ORIGINS` | — | CORS: список origin'ов или `*`. |
| `OPEN_METEO_FORECAST_URL` | `https://ensemble-api.open-meteo.com` | Базовый URL источника погоды. |
| `OPEN_METEO_FORECAST_PATH` | `/v1/ensemble` | Путь эндпоинта погоды. |
| `OPEN_METEO_MODELS` | `gfs05` | Модель для ансамблевого хоста. **Пустое значение = не отправлять параметр.** |
| `OPEN_METEO_GEOCODING_URL` | официальный | Базовый URL геокодирования. |
| `OPEN_METEO_AIR_QUALITY_URL` | официальный | Базовый URL качества воздуха. |
| `OPEN_METEO_API_KEY` | — | Только для платного тарифа. |
| `OPEN_METEO_TIMEOUT_MS` | `15000` | Таймаут одного запроса. |
| `OPEN_METEO_MAX_RETRIES` | `2` | Повторы для временных сбоев. |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`/`silent`. |

Некорректные значения (например `MCP_PORT=99999` или `LOG_LEVEL=verbose`) приводят к **падению при старте с понятным сообщением**, а не к тихой подстановке дефолта.

---

## Структура проекта

```
src/
  index.ts                  точка входа, выбор транспорта, graceful shutdown
  config.ts                 разбор и валидация окружения
  logger.ts                 JSON-логи в stderr
  server.ts                 фабрика McpServer + instructions для модели
  http.ts                   Streamable HTTP: роутинг, auth, CORS, сессии
  version.ts                имя/версия сервера
  open-meteo/
    client.ts               HTTP-клиент: таймауты, retry, backoff
    errors.ts               типизированные ошибки
    types.ts                формы ответов upstream
    weather-codes.ts        расшифровка кодов WMO (en/ru)
  tools/
    index.ts                регистрация всех инструментов
    deps.ts                 зависимости инструментов
    schemas.ts              общие схемы локации (вход и выход)
    result.ts               формат результата, guard ошибок, единицы
    coerce.ts               нормализация «сырого» JSON upstream
    shared.ts               разрешение локации, geocode-хелперы
    geocode.ts              инструмент 1
    current-weather.ts      инструмент 2
    forecast.ts             инструмент 3
    air-quality.ts          инструмент 4
test/
  unit.test.ts              конфиг, клиент, декодеры (27 тестов)
  integration.test.ts       полный round-trip через MCP-клиент (27 тестов)
  mock-upstream.ts          локальный мок Open-Meteo
scripts/
  smoke.ts                  «живая» проверка против настоящего API
deploy/
  open-meteo-mcp.service    systemd unit
  nginx.conf.example        reverse proxy + TLS
  dsh-mcp-overlay.example.yml  готовое подключение к DSH
```

---

## Тесты

```bash
npm test          # 54 теста: unit + integration, полностью герметично
npm run typecheck
```

Интеграционные тесты поднимают **настоящий MCP-клиент** (`Client` + `InMemoryTransport`) и прогоняют реальный handshake, `tools/list`, валидацию аргументов и валидацию `structuredContent` по `outputSchema`. Upstream подменяется локальным моком (`test/mock-upstream.ts`), который повторяет контракт Open-Meteo: списки переменных, выравненные массивы, переключение единиц, пустой результат и конверт с ошибкой.

Что покрыто, помимо логики:

- все 4 инструмента зарегистрированы, у каждого есть title/description/annotations;
- **у каждого входного параметра есть описание** в сгенерированной JSON Schema;
- у каждого инструмента объявлен `outputSchema`;
- каждый инструмент возвращает и текст, и `structuredContent`;
- ошибки валидации и ошибки upstream превращаются в понятные `isError`-ответы;
- невалидные аргументы не доходят до сети;
- **переключение источника погоды**: тест собирает сервер с `OPEN_METEO_FORECAST_PATH=/v1/forecast` и без модели и проверяет, что запрос уходит именно на стандартный хост и без параметра `models` — то есть конфигурация для VPS покрыта тестом, а не только документацией;
- retry/таймаут/отмена, классы ошибок, разбор «сырого» JSON.

Живая проверка (нужен интернет):

```bash
npm run smoke
```

---

## Безопасность

- **Публичный bind без токена запрещён.** Сервер падает при старте, если `MCP_HOST` не loopback и не задан `MCP_AUTH_TOKEN` (обойти можно только явным `MCP_ALLOW_UNAUTHENTICATED=true`).
- Токен сравнивается **за постоянное время** (`timingSafeEqual`) — его нельзя подобрать по таймингам.
- Токен принимается **только в заголовке** `Authorization`, не в query-параметре (query попадает в логи прокси).
- Все инструменты помечены `readOnlyHint: true`, `destructiveHint: false` — агент видит, что они ничего не меняют.
- Наружу не отдаются стектрейсы и внутренние адреса.
- Ограничение размера тела запроса; на VPS дополнительно ограничьте `client_max_body_size` в nginx.
- Логи идут в stderr, stdout свободен для протокола — случайный `console.log` не порвёт MCP-сессию.

Что стоит сделать перед публикацией в интернет:

1. TLS обязателен — иначе токен уходит открытым текстом.
2. Ограничьте частоту на уровне прокси: бесплатный тариф Open-Meteo имеет лимиты, а `/mcp` без rate limit — удобная точка для абьюза.
3. Ротируйте `MCP_AUTH_TOKEN` и не коммитьте `.env` (он в `.gitignore`).
4. `/healthz` намеренно без аутентификации — закройте его от интернета средствами прокси (пример в `nginx.conf.example`).

---

## Известные ограничения

- **Геокодирование работает только по названиям.** Улицы, индексы и достопримечательности не находятся — это ограничение самого Open-Meteo.
- **Данные — это выход модели, а не показания станции.** Погода обновляется примерно раз в 15 минут, качество воздуха — раз в час; значения могут слегка отличаться от уличного термометра.
- **`precipitation_probability` равен `null` в конфигурации по умолчанию** (ансамблевый хост его не отдаёт). Переключение на стандартный хост возвращает это поле — см. [Источник данных](#источник-данных).
- **`api.open-meteo.com` может быть недоступен из вашей сети.** Это не ошибка сервера: дефолт настроен на доступный хост. На VPS имеет смысл проверить `curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 'https://api.open-meteo.com/v1/forecast?latitude=55.75&longitude=37.61&current=temperature_2m'` и, если он отвечает, переключиться на конфигурацию B.
- **Прогноз дальше ~7 дней — это тренд**, а не точное предсказание. Сервер отдаёт до 16 дней, но в описании инструмента это оговорено явно.
- **Регион `stateful`** хранит сессии в памяти процесса: при рестарте они теряются, и клиент должен инициализироваться заново. Для VPS по умолчанию используется `stateless`.
- **`include_hourly` на 16 дней** даёт ~384 объекта — большой ответ; включайте осознанно. На ансамблевом хосте ответ дополнительно содержит данные всех членов ансамбля, поэтому он заметно тяжелее (~500 КБ против ~200 КБ на стандартном хосте).
- **Лимит запросов.** У бесплатного тарифа Open-Meteo есть поминутное ограничение; при его превышении сервер вернёт `rate_limited` с пометкой, что запрос временный. При частых вызовах стоит добавить кэширование перед сервером.
