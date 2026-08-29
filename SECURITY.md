# Безопасность — AI MyWay DeN

- Не коммитьте пароли, токены Telegram, API-ключи Ollama и личные данные аккаунтов.
- Скрипт работает только на `*.moswar.ru` — не расширяйте `@match` без необходимости.
- Обновления ставьте только с официального репозитория: [AI-Script-MyWay-Moswar](https://github.com/DeN07-ai/AI-Script-MyWay-Moswar).
- **Отчёты автору** выключены по умолчанию (⚙️ в хабе). Даже во включённом режиме IP не отправляется.
- **WhiteList** гостей — файл `whitelist.txt` в этом репозитории (raw GitHub), не Pastebin.
- Токен Telegram **пользователя** хранится в Tampermonkey (`GM_setValue`), не в `localStorage` страницы. Старый ключ `moswar_bot_config_admin` переносится и удаляется.

При обнаружении уязвимости — сообщите автору через Issues на GitHub (без публикации эксплойта).
