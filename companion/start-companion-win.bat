@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title MyWay Moswar Companion

echo ========================================================
echo    MyWay Moswar Companion — запуск на Windows
echo ========================================================
echo.

call :need_node
if errorlevel 1 goto :fail

if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"

set "WANT=%~1"
set "BROWSER="
set "BROWSER_NAME="
set "PROFILE="

if /I "%WANT%"=="yandex" goto :force_yandex
if /I "%WANT%"=="chrome" goto :force_chrome

call :pick_chrome
if defined BROWSER goto :have_browser
call :pick_yandex
goto :have_browser

:force_chrome
call :pick_chrome
goto :have_browser

:force_yandex
call :pick_yandex
goto :have_browser

:have_browser
if not defined BROWSER goto :no_browser

echo Браузер: %BROWSER_NAME%
echo Файл:    %BROWSER%
echo Профиль: %PROFILE%
echo.

call :port_open
if "%PORT_OPEN%"=="1" goto :already_open

echo Открываю игру в отдельном окне браузера.
echo В этом окне нужно один раз войти в игру.
echo Не закрывайте его, пока работает модуль «Рейды».
echo.
start "" "%BROWSER%" --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="%PROFILE%" "https://www.moswar.ru/travel2/"

echo Жду, пока браузер откроет порт 9222...
set /a TRIES=0

:wait_loop
set /a TRIES+=1
call :port_open
if "%PORT_OPEN%"=="1" goto :port_ready
if %TRIES% GEQ 25 goto :port_slow
ping -n 2 127.0.0.1 >nul
goto :wait_loop

:port_ready
echo Порт 9222 открыт.
goto :run_companion

:port_slow
echo.
echo Браузер ещё не открыл порт 9222.
echo Если окно игры не появилось, закройте все окна этого профиля и запустите файл снова.
echo Companion всё равно запускаю: он подключится, когда порт появится.
goto :run_companion

:already_open
echo Порт 9222 уже открыт. Новое окно браузера не запускаю.
echo Если это не окно игры, закройте другие браузеры с отладкой и запустите файл снова.
goto :run_companion

:run_companion
echo.
echo Companion работает в этом окне. Не закрывайте его, пока идут рейды.
echo Чтобы остановить — закройте это окно.
echo.
node companion.js
echo.
echo Companion остановился.
echo.
pause
exit /b 0

:no_browser
echo [ОШИБКА] Не удалось найти браузер.
if /I "%WANT%"=="chrome" echo Нужен Google Chrome: https://www.google.com/chrome/
if /I "%WANT%"=="yandex" echo Нужен Яндекс.Браузер: https://browser.yandex.ru/
if /I not "%WANT%"=="chrome" if /I not "%WANT%"=="yandex" (
    echo Установите Google Chrome или Яндекс.Браузер и запустите этот файл снова.
    echo Chrome: https://www.google.com/chrome/
    echo Яндекс: https://browser.yandex.ru/
    echo.
    echo Если нужны именно Яндекс при уже установленном Chrome:
    echo start-companion-win.bat yandex
)
goto :fail

:fail
echo.
pause
exit /b 1

:need_node
where node >nul 2>nul
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден.
    echo Скачайте установщик LTS, версия 22 или новее:
    echo https://nodejs.org/en/download
    echo После установки закройте это окно и запустите файл снова.
    exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22 && typeof WebSocket==='function'?0:1)"
if errorlevel 1 (
    echo [ОШИБКА] Нужен Node.js 22 или новее, со встроенным WebSocket.
    echo Сейчас установлено:
    node -p "process.version"
    echo Скачайте установщик LTS:
    echo https://nodejs.org/en/download
    echo После установки закройте это окно и запустите файл снова.
    exit /b 1
)
exit /b 0

:pick_chrome
set "BROWSER="
set "BROWSER_NAME=Google Chrome"
set "PROFILE=%LOCALAPPDATA%\MyWayMoswar\Chrome"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER call :chrome_pf86
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER call :chrome_reg
exit /b 0

:chrome_pf86
set "PF86=%ProgramFiles(x86)%"
if exist "%PF86%\Google\Chrome\Application\chrome.exe" set "BROWSER=%PF86%\Google\Chrome\Application\chrome.exe"
exit /b 0

:chrome_reg
call :reg_sz_path "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
if defined REGPATH if exist "%REGPATH%" set "BROWSER=%REGPATH%"
if defined BROWSER exit /b 0
call :reg_sz_path "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
if defined REGPATH if exist "%REGPATH%" set "BROWSER=%REGPATH%"
exit /b 0

:pick_yandex
set "BROWSER="
set "BROWSER_NAME=Яндекс.Браузер"
set "PROFILE=%LOCALAPPDATA%\MyWayMoswar\Yandex"
if exist "%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe"
if not defined BROWSER if exist "%ProgramFiles%\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=%ProgramFiles%\Yandex\YandexBrowser\Application\browser.exe"
if not defined BROWSER call :yandex_pf86
exit /b 0

:yandex_pf86
set "PF86=%ProgramFiles(x86)%"
if exist "%PF86%\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=%PF86%\Yandex\YandexBrowser\Application\browser.exe"
exit /b 0

:port_open
set "PORT_OPEN=0"
powershell -NoProfile -Command "try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1',9222); $c.Close(); exit 0 } catch { exit 1 }"
if not errorlevel 1 set "PORT_OPEN=1"
exit /b 0

:reg_sz_path
set "REGPATH="
set "REGLINE="
for /f "delims=" %%L in ('reg query "%~1" /ve 2^>nul ^| findstr /I "REG_SZ"') do set "REGLINE=%%L"
if not defined REGLINE exit /b 0
set "REGPATH=%REGLINE:*REG_SZ=%"
for /f "tokens=*" %%P in ("%REGPATH%") do set "REGPATH=%%P"
exit /b 0
