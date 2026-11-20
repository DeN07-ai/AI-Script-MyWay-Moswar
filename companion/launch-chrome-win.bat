@echo off
rem Запуск Google Chrome на Windows с отладочным портом 9222
start chrome.exe --remote-debugging-port=9222 --remote-allow-origins=* "https://www.moswar.ru/travel2/"
echo Google Chrome запущен с портом отладки 9222
