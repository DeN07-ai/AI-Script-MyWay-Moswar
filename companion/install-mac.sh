#!/usr/bin/env bash
#
# Установка MyWay Moswar Companion на macOS.
#
# Делает всё необходимое одним запуском:
#   1. проверяет Node.js и компилятор clang;
#   2. собирает нативный кликер (Accessibility + CoreGraphics);
#   3. ставит LaunchAgent, чтобы Companion стартовал при входе в систему;
#   4. запускает Companion и ПРОВЕРЯЕТ реальную готовность к кликам;
#   5. если macOS не даёт доступ Accessibility — открывает нужную настройку
#      и показывает точный путь, который нужно добавить. Это единственное
#      действие, которое система безопасности не может выполнить за нас.
#
# Скрипт не трогает другие файлы и не требует sudo.
# Повторный запуск безопасен (идемпотентен).
#
set -euo pipefail

cd "$(dirname "$0")"
COMPANION_JS="$PWD/companion.js"
CLICKER="$PWD/bin/mw_clicker_mac"
LABEL="ru.myway.moswar.companion"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${MW_COMPANION_PORT:-3999}"

say()  { printf '%b\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

say "=================================================="
say "  MyWay Moswar Companion · установка (macOS)"
say "=================================================="

# ---------- 1. зависимости ----------
if ! command -v node >/dev/null 2>&1; then
  bad "Node.js не найден."
  say "  Установите Node.js 18+ с https://nodejs.org/ (пакет .pkg) и запустите"
  say "  этот скрипт ещё раз."
  exit 1
fi
NODE_BIN="$(command -v node)"
ok "Node.js: $(node -v) ($NODE_BIN)"

if ! command -v clang >/dev/null 2>&1; then
  bad "Компилятор clang не найден — без него не собрать кликер."
  say "  Установка занимает пару минут, скачивание идёт с серверов Apple:"
  say ""
  say "      xcode-select --install"
  say ""
  say "  После появления окна выберите «Установить» и запустите этот скрипт снова."
  exit 1
fi
ok "clang: $(clang --version | head -1)"

# ---------- 2. сборка кликера ----------
mkdir -p bin
say ""
say "[1/4] Сборка нативного кликера…"
if clang -framework ApplicationServices -framework CoreGraphics -framework CoreFoundation \
         -Wall -Wextra -O2 macos_clicker.c -o "$CLICKER" 2>/tmp/mw-clicker-build.log; then
  ok "Кликер собран: $CLICKER"
else
  bad "Не удалось собрать кликер:"
  sed 's/^/      /' /tmp/mw-clicker-build.log
  exit 1
fi

# ---------- 3. LaunchAgent ----------
say ""
say "[2/4] Настройка автозапуска…"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$COMPANION_JS</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/MyWayCompanion.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/MyWayCompanion.log</string>
</dict>
</plist>
XML
ok "LaunchAgent: $PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
sleep 2
ok "Companion запущен (порт $PORT)"

# ---------- 4. проверка готовности ----------
say ""
say "[3/4] Проверка готовности…"
STATUS_JSON="$(curl -s --max-time 25 "http://127.0.0.1:$PORT/status" || echo '{}')"

read_field() { printf '%s' "$STATUS_JSON" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const j=JSON.parse(s);const f='$1'.split('.').reduce((a,k)=>a==null?a:a[k],j);
  console.log(typeof f==='object'?JSON.stringify(f):String(f));}catch(e){console.log('null')}});
"; }

TRUSTED="$(read_field axTrusted)"
READY="$(read_field clickReady)"
PIDFound="$(read_field chromePid)"

if [ "$TRUSTED" = "true" ]; then
  ok "Доступ Accessibility выдан"
else
  bad "macOS не даёт процессу Companion доступ к Accessibility"
  say ""
  say "  Это настройка безопасности, её можно изменить только вручную — ОДИН РАЗ."
  say "  1. Откроется окно «Специальные возможности». Нажмите «+»."
  say "  2. В диалоге выбора файлов нажмите Cmd+Shift+G и вставьте путь:"
  say ""
  echo "        $NODE_BIN"
  say ""
  say "  3. Подтвердите добавление и убедитесь, что переключатель включён."
  say "  4. Запустите ./companion-mac-status.sh для проверки."
  say ""
  "$CLICKER" --prompt >/dev/null 2>&1 || true
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
fi

if [ -n "$PIDFound" ] && [ "$PIDFound" != "null" ] && [ "$PIDFound" != "0" ]; then
  ok "Браузер найден (PID $PIDFound)"
else
  info "Браузер не запущен — это нормально, Companion найдёт его сам при запуске."
fi

say ""
say "[4/4] Итог"
if [ "$READY" = "true" ]; then
  say ""
  say "  \033[32mВСЁ ГОТОВО.\033[0m Companion будет запускаться сам при входе в систему."
  say "  Масштаб страницы (80%, 100%, 110%) и размер окна значения не имеют —"
  say "  координаты считаются из реальной геометрии окна."
  say ""
  say "  Дальше нужно только: открыть moswar.ru → /travel2/ → включить модуль «Рейды»."
else
  say ""
  say "  Companion работает, но к кликам пока НЕ готов. Выполните шаги выше"
  say "  (доступ Accessibility) и проверьте командой:"
  say "      ./companion-mac-status.sh"
  say ""
  say "  Альтернатива без автозапуска: запускать Companion из терминала, который"
  say "  уже имеет доступ (например, этот скрипт из Terminal/iTerm):"
  say "      ./start-companion-mac.sh"
fi
say "=================================================="
