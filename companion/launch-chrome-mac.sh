#!/usr/bin/env bash
# Запуск Google Chrome на Mac с отладочным портом для работы через CDP
open -a "Google Chrome" --args --remote-debugging-port=9222 --remote-allow-origins=* "https://www.moswar.ru/travel2/"
echo "Google Chrome запущен с портом отладки 9222"
