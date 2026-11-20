#!/usr/bin/env bash
#
# Быстрая диагностика MyWay Moswar Companion (macOS).
# Показывает, готов ли Companion выполнить настоящий клик прямо сейчас,
# и если нет — что именно мешает.
#
set -uo pipefail
cd "$(dirname "$0")"

PORT="${MW_COMPANION_PORT:-3999}"
JSON="$(curl -s --max-time 25 "http://127.0.0.1:$PORT/status" 2>/dev/null)"

if [ -z "$JSON" ]; then
  echo "✖ Companion НЕ отвечает на http://127.0.0.1:$PORT"
  echo "  Запуск:  ./install-mac.sh      (установка + автозапуск)"
  echo "           ./start-companion-mac.sh  (разовый запуск в терминале)"
  exit 1
fi

node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch (e) { console.log("✖ Некорректный ответ:", s.slice(0, 200)); process.exit(1); }
  const line = (mark, text) => console.log((mark ? "  ✔ " : "  ✖ ") + text);
  const ready = !!j.clickReady;

  console.log("MyWay Moswar Companion v" + (j.version || "?") + " · порт " + j.port);
  console.log("");
  line(!!(j.clicker && j.clicker.ready), "Нативный кликер: " +
    (j.clicker && j.clicker.ready ? "собранный бинарник готов"
      : "НЕ готов → " + (j.clicker && j.clicker.error)));
  line(!!j.axTrusted, "Доступ Accessibility: " + (j.axTrusted ? "выдан"
    : "НЕ выдан. Добавьте в «Системные настройки → Конфиденциальность → Специальные возможности» путь к node (см. install-mac.sh)"));
  line(!!j.chromePid, "Браузер: " + (j.chromePid ? "PID " + j.chromePid
    : "не найден (откройте любую страницу moswar.ru)"));

  const w = j.window || {};
  line(!!w.webarea, "Окно с веб-областью: " + (w.error ? "ошибка → " + w.error
    : (w.title || "?") + " · viewport " + (w.area ? w.area.w + "×" + w.area.h : "?")));
  line(!!(j.cdp && j.cdp.connected), "CDP (не обязателен на macOS): " +
    (j.cdp && j.cdp.connected ? "порт " + j.cdp.port : "не подключён"));

  console.log("");
  console.log(ready
    ? "ИТОГ: готов выполнять аппаратные клики (isTrusted = true)."
    : "ИТОГ: НЕ готов. Скрипт в этом случае бои НЕ запускает — синтетический клик сервер отвергает.");
  process.exit(ready ? 0 : 1);
});
' <<< "$JSON"
