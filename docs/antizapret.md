# AWG Sync как дополнение к AntiZapret

[← На главную](../README.md)

Для уже работающего [AntiZapret v6](https://github.com/xtrime-ru/antizapret-vpn-docker) нужны только готовый Docker-образ и существующий HTTPS-прокси AZ. Скачивать исходники, устанавливать Node.js или собирать приложение на сервере не нужно.

Все команды выполняйте **из папки AntiZapret**, например:

```bash
cd /root/antizapret
```

## 1. Добавьте логин и пароль

В существующий файл **`.env`** добавьте две строки. Придумайте свой длинный пароль вместо примера:

```dotenv
AWG_SYNC_USER=admin
AWG_SYNC_PASS='ЗАМЕНИТЕ_НА_СВОЙ_ДЛИННЫЙ_ПАРОЛЬ'
```

Это вход в AWG Sync. Доступы к VPN-панелям и роутерам задаются позже в браузере. Остальные строки `.env` сохраните.

## 2. Дополните docker-compose.override.yml

Добавьте сервис `awg-sync` под существующий ключ **`services:`**:

```yaml
services:
  awg-sync:
    image: ghcr.io/razgame/keeneticazsync:latest
    hostname: awg-sync.antizapret
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    environment:
      BASIC_AUTH_USER: ${AWG_SYNC_USER:-admin}
      BASIC_AUTH_PASS: ${AWG_SYNC_PASS:?Set AWG_SYNC_PASS in .env}
    volumes:
      - awg-sync-config:/app/config

volumes:
  awg-sync-config:
```

`volumes:` внизу — общий раздел файла, на одном уровне с `services:`. Если эти разделы уже есть, дополните их, не создавая повторно. Docker сам создаст том для настроек с нужными правами и сохранит его при обновлениях приложения.

Под существующим сервисом **`https`** добавьте маршрут и порт:

```yaml
services:
  https:
    ports:
      - "8787:8787"
    environment:
      PROXY_SERVICE_9: AWG Sync:8787:awg-sync.antizapret:8787
```

Сохраните остальные настройки `https`. Если `environment` записан списком (`- ИМЯ=значение`), добавьте маршрут в таком же формате: `- PROXY_SERVICE_9=AWG Sync:8787:awg-sync.antizapret:8787`.

В стандартном AZ номера 1–8 уже заняты. Если вы добавляли свои маршруты, используйте следующий свободный номер **без пропусков**. Отдельный домен и второй HTTPS-контейнер не нужны.

Полный пример обоих сервисов: [docker-compose.override.sample.yml](../docker-compose.override.sample.yml). Его нужно объединить со своим файлом, сохранив имеющиеся сервисы и настройки.

## 3. Запустите

```bash
docker compose config --quiet
docker compose pull awg-sync
docker compose up -d --no-deps awg-sync https
```

Первая команда проверяет настройки: при успехе она ничего не выводит. Если появилась ошибка, исправьте её перед запуском. Обновление `https` может ненадолго прервать доступ к веб-панелям; VPN-контейнеры эти команды не перезапускают.

Откройте **`https://ваш-адрес-AZ:8787`**. Например, для AZ на `https://vpn.example.com:5443` это будет `https://vpn.example.com:8787`. Войдите с паролем из `.env` и пройдите [первую настройку](../README.md#первая-настройка).

Если страница недоступна, разрешите входящий **TCP 8787** в firewall сервера и хостинга. Порт самого `awg-sync` напрямую наружу публиковать не нужно — доступ обеспечивает `https`.

## Обновление

Сначала скачайте зашифрованную резервную копию в разделе **«Конфигурация»**. Затем из папки AZ выполните:

```bash
docker compose pull awg-sync
docker compose up -d --no-deps awg-sync
```

Настройки останутся в Docker-томе. Не удаляйте его командой `docker compose down -v`. Для фиксации определённой сборки вместо `latest` укажите тег `sha-<полный хеш коммита>` или digest из [списка образов](https://github.com/RazGame/KeeneticAZSync/pkgs/container/keeneticazsync).

<details>
<summary>Если AWG Sync уже установлен со сборкой из исходников</summary>

Повторять новую установку и переносить настройки в пустой том не нужно. Сохраните резервную копию через «Конфигурация». В существующем сервисе `awg-sync` замените `image` на `ghcr.io/razgame/keeneticazsync:latest` и удалите блок `build`. **Оставьте прежнее подключение папки настроек**, например `./config/awg-sync:/app/config`, а также свои переменные входа и HTTPS-маршрут.

Если раньше использовался дополнительный файл `docker-compose.awg-sync.yml`, перенесите его сервисы в обычный `docker-compose.override.yml`, объединяя существующие разделы. Логин и пароль из `.env.awg-sync` добавьте в основной `.env` AZ. После этого используйте обычные команды обновления выше из папки AZ.

</details>

<details>
<summary>Добавить ссылку в Dashboard AZ</summary>

Если сервис `dashboard` уже включён, добавьте в его `environment`:

```yaml
DASHBOARD_SERVICE_6: AWG Sync:8787:awg-sync.antizapret:8787
```

Номер 6 подходит стандартной установке. Если он занят, выберите следующий свободный без пропусков. Примените: `docker compose up -d --no-deps dashboard`.

</details>

## Проверить работу

```bash
docker compose ps awg-sync https
docker compose logs --tail=100 awg-sync
```

У `awg-sync` должен появиться статус `healthy`. При ошибке `502` проверьте, что контейнер запущен и имя `awg-sync.antizapret` совпадает с HTTPS-маршрутом. Если пропал доступ только к роутеру, проверьте, что его адрес управления доступен с сервера AZ.
