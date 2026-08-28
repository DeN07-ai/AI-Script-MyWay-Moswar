# ИИ скрипт MyWay Moswar

Модульный userscript для [moswar.ru](https://www.moswar.ru): панель модулей, планировщик и автоматизация локаций.

**GitHub:** [DeN07-ai/AI-Script-MyWay-Moswar](https://github.com/DeN07-ai/AI-Script-MyWay-Moswar)

## Файлы проекта

| Файл | Назначение |
|------|------------|
| `AI MyWay DeN.js` | исходник для разработки |
| `AI MyWay DeN.user.js` | публикуемая копия для Tampermonkey (`@updateURL` / `@downloadURL`) |
| `README_AI_MyWay_DeN_Instructions.md` | полная инструкция по модулям |
| `SECURITY.md` | политика безопасности |

**Рабочая папка на Mac:** `/Users/denisgrisko/Documents/MyWay-Moswar/AI-Script`

## Установка

1. Установите [Tampermonkey](https://www.tampermonkey.net/) или Violentmonkey.
2. Установите скрипт с GitHub:
   - [AI MyWay DeN.user.js (raw)](https://github.com/DeN07-ai/AI-Script-MyWay-Moswar/raw/refs/heads/main/AI%20MyWay%20DeN.user.js)
3. Откройте `https://*.moswar.ru/*` и включите нужные модули в панели.

## Модули (актуально)

| Модуль | Версия | Что делает |
|--------|--------|------------|
| Рейды | 6.1 | Циклы, фарм 100%, акция, сильный босс |
| Крысопровод | 1.9.5 | Руда / акционный дроп / **тёмный тоннель** (коллекции, ларец, ключи 36–40) |
| Нефтепровод | 3.7 | Нефть, сникерсы, партбилеты, акция, мини-игры, патруль |
| Подземка | 1.3.17 | Групповая подземка, авто + циклы |
| Автофлаг | 4.3 | Автозапись на противостояние |
| Спутники | 3.0 | Строительство |
| ИИ | 4.21 | Ollama Intelligence |
| Фулл Доп | 2.9 | Допы, питомцы, бонусы |
| Фу-Баги | 1.0 | Рюкзаки КОМП, награда, нормализация багов |
| МиниБот | 0.7.11 | Хаос, флаг, дуэли, патруль, шаурма, пахан, дэпс, ИИ |
| Субботний ОМОН | 3.1 | ОМОН, каски/орехи |
| Око Провидения | 1.0 | Панель абилок в групповом бою |

## Разработка

1. Правки в `AI MyWay DeN.js`.
2. Перед релизом: скопировать в `AI MyWay DeN.user.js`, обновить `@version` в шапке.
3. Commit + push в `main` на GitHub.

Связанный проект (desktop): [Desktop-Bot-Moswar-MyWay](../Desktop-Bot) — Electron-приложение DM.
