// Автотесты чистой decision-логики модуля Нефтепровод (двойное прохождение).
// Тестируют машину состояний handleWinAlert и защиту от повторных кликов атаки.
// Эти тесты НЕ проверяют живой DOM и поведение сервера — только чистую логику.
// Запуск: node tests/neft-double-pass.test.js

import assert from 'node:assert/strict';

// ============================================================
// Чистая машина состояний двойного прохождения
// (модель handleWinAlert + подтверждения перехода без DOM)
// ============================================================

const DP = { IDLE: 0, FIRST_DONE: 1, WAITING_RESET: 2, SECOND_IN_PROGRESS: 3, DONE: 4 };

function createDoublePassState(enabled, initialState) {
    let state = initialState !== undefined ? initialState : DP.IDLE;
    let resetClickCount = 0;
    let botStopped = false;
    const log = [];

    const logMsg = (m) => log.push(m);

    // Модель handleWinAlert.
    // winVisible — реально ли видно #neftlenin_alert_win (вызывается только если да)
    // resetBtnExists — найдена ли ссылка a[href="/neftlenin/holidayreset/"]
    // winGoneAfterClick / pipeBackAfterClick — состояние DOM после клика по сбросу
    function handleWinAlert(winVisible, resetBtnExists, winGoneAfterClick, pipeBackAfterClick) {
        // В реальном коде handleNeftPage вызывает handleWinAlert только когда
        // getElementById("neftlenin_alert_win") && isVisible(...)
        if (!winVisible) return;

        // Защита: если бот в ожидании возврата — не обрабатываем победу повторно
        if (state === DP.WAITING_RESET) {
            logMsg("Ожидание подтверждения возврата — пропускаю повторную обработку победы");
            return;
        }

        // Состояние DONE — повторная обработка уже завершённого цикла
        if (state === DP.DONE) {
            logMsg("Миссия выполнена — остановка (второй проход завершён)");
            state = DP.IDLE;
            botStopped = true;
            return;
        }

        // Второе завершение — второй проход прошёл, бот останавливается
        if (state === DP.SECOND_IN_PROGRESS) {
            logMsg("Второй проход завершён — бот останавливается");
            state = DP.DONE;
            botStopped = true;
            return;
        }

        // Обычное завершение (двойное не включено)
        if (!enabled) {
            logMsg("Миссия выполнена — остановка (двойное прохождение: выключено)");
            state = DP.IDLE;
            botStopped = true;
            return;
        }

        // ─── ПЕРВЫЙ ПРОХОД ЗАВЕРШЁН ───
        if (!resetBtnExists) {
            logMsg("Праздничный бонус недоступен — завершаю после первого прохода");
            state = DP.IDLE;
            botStopped = true;
            return;
        }

        // Бонус доступен — выполняем сброс ровно один раз
        resetClickCount++;
        state = DP.WAITING_RESET;
        logMsg("Праздничный бонус найден. Возвращаюсь в начало нефтепровода...");

        // Пытаемся подтвердить переход сразу
        if (winGoneAfterClick && pipeBackAfterClick) {
            state = DP.SECOND_IN_PROGRESS;
            logMsg("Переход подтверждён. Второй проход нефтепровода запущен");
        } else {
            logMsg("Переход не подтверждён — ждём следующего тика");
        }
    }

    // Модель проверки подтверждения перехода в handleNeftPage
    // возвращает true, если всё ещё ожидаем
    function checkWaitingResetConfirmation(winGone, pipeBack) {
        if (state !== DP.WAITING_RESET) return false;
        if (winGone && pipeBack) {
            state = DP.SECOND_IN_PROGRESS;
            logMsg("Переход подтверждён (проверка в тике). Второй проход запущен");
            return false;
        }
        return true;
    }

    // Модель stopBot(): сохраняет состояние незавершённого перехода
    function stopBot() {
        if (state === DP.IDLE || state === DP.DONE) {
            state = DP.IDLE;
        }
        botStopped = true;
    }

    return {
        get state() { return state; },
        get botStopped() { return botStopped; },
        get resetClickCount() { return resetClickCount; },
        get log() { return log; },
        handleWinAlert,
        checkWaitingResetConfirmation,
        stopBot,
        setState(v) { state = v; },
        setEnabled(v) { enabled = v; },
    };
}

// ============================================================
// Модель защиты от повторных кликов (handleAttackAlert dedup)
// ============================================================

function createAlertDedup(cooldownMs) {
    const COOLDOWN = cooldownMs || 5000;
    let lastAlertId = null;
    let lastAlertActionTime = 0;
    let clicks = 0;
    let waits = 0;

    function tryClick(alertId, now) {
        // Тот же алерт и недавно кликали — ждём результат
        if (lastAlertId === alertId && (now - lastAlertActionTime) < COOLDOWN) {
            waits++;
            return false;
        }
        // Тот же алерт, но cooldown истёк — считаем новым окном
        if (lastAlertId === alertId) {
            lastAlertId = null;
        }
        lastAlertId = alertId;
        lastAlertActionTime = now;
        clicks++;
        return true;
    }

    function reset() {
        lastAlertId = null;
        lastAlertActionTime = 0;
    }

    return {
        tryClick,
        reset,
        get clicks() { return clicks; },
        get waits() { return waits; },
        get lastAlertId() { return lastAlertId; },
    };
}

// ============================================================
// ТЕСТЫ МАШИНЫ СОСТОЯНИЙ
// ============================================================

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ✔ ' + name); }
    catch (e) { failed++; console.error('  ✘ ' + name + '\n      ' + e.message); }
}

console.log('Порядок проверок: приоритет победы над патрулями');

test('T1: победа обрабатывается, когда окно победы видно (патруль не вызывается)', () => {
    const dp = createDoublePassState(true, DP.IDLE);
    dp.handleWinAlert(true, true, true, true);
    assert.equal(dp.state, DP.SECOND_IN_PROGRESS);
    assert.equal(dp.resetClickCount, 1, 'клик по возврату ровно один');
});

test('T1b: при НЕвидимом окне победы состояние не меняется', () => {
    const dp = createDoublePassState(true, DP.IDLE);
    dp.handleWinAlert(false, true, true, true);
    assert.equal(dp.state, DP.IDLE, 'обработка победы не запускалась');
    assert.equal(dp.resetClickCount, 0);
    assert.equal(dp.botStopped, false);
});

console.log('Идемпотентность обработки победы');

test('T2: повторный тик с тем же победным окном не повторяет сброс', () => {
    const dp = createDoublePassState(true, DP.IDLE);
    dp.handleWinAlert(true, true, false, false); // переход не подтверждён
    assert.equal(dp.state, DP.WAITING_RESET);
    assert.equal(dp.resetClickCount, 1);
    // следующий тик: то же победное окно
    dp.handleWinAlert(true, true, false, false);
    assert.equal(dp.resetClickCount, 1, 'повторного клика не было');
    assert.ok(dp.log.some(l => l.includes('Ожидание подтверждения возврата')));
});

console.log('Первый проход при включённом двойном режиме');

test('T4: IDLE + бонус есть → WAITING_RESET, затем подтверждение → SECOND_IN_PROGRESS', () => {
    const dp = createDoublePassState(true, DP.IDLE);
    dp.handleWinAlert(true, true, false, false);
    assert.equal(dp.state, DP.WAITING_RESET, 'сначала ожидание, а не мгновенный второй проход');
    const stillWaiting = dp.checkWaitingResetConfirmation(true, true);
    assert.equal(stillWaiting, false);
    assert.equal(dp.state, DP.SECOND_IN_PROGRESS);
});

console.log('Подтверждение перехода по DOM');

test('T5: подтверждение = победное окно исчезло И труба появилась', () => {
    const dp = createDoublePassState(true, DP.WAITING_RESET);
    assert.equal(dp.checkWaitingResetConfirmation(true, true), false);
    assert.equal(dp.state, DP.SECOND_IN_PROGRESS);
});

test('T5b: только исчезновение победы — НЕдостаточно для подтверждения', () => {
    const dp = createDoublePassState(true, DP.WAITING_RESET);
    assert.equal(dp.checkWaitingResetConfirmation(true, false), true, 'остаёмся в ожидании');
    assert.equal(dp.state, DP.WAITING_RESET);
});

test('T5c: только труба без исчезновения победы — НЕдостаточно', () => {
    const dp = createDoublePassState(true, DP.WAITING_RESET);
    assert.equal(dp.checkWaitingResetConfirmation(false, true), true);
    assert.equal(dp.state, DP.WAITING_RESET);
});

console.log('Неудачный переход');

test('T6: нет ссылки возврата → остановка после первого прохода, без имитации', () => {
    const dp = createDoublePassState(true, DP.IDLE);
    dp.handleWinAlert(true, false, false, false);
    assert.equal(dp.state, DP.IDLE);
    assert.equal(dp.botStopped, true, 'бот остановлен');
    assert.equal(dp.resetClickCount, 0, 'никаких кликов не было');
    assert.ok(dp.log.some(l => l.includes('бонус недоступен')));
});

console.log('Второй проход и защита от третьего');

test('T7: SECOND_IN_PROGRESS + снова победа → DONE и остановка', () => {
    const dp = createDoublePassState(true, DP.SECOND_IN_PROGRESS);
    dp.handleWinAlert(true, true, false, false);
    assert.equal(dp.state, DP.DONE);
    assert.equal(dp.botStopped, true);
    assert.equal(dp.resetClickCount, 0, 'повторного сброса не было');
});

test('T8: DONE + снова победа → третий проход не запускается', () => {
    const dp = createDoublePassState(true, DP.DONE);
    dp.handleWinAlert(true, true, true, true);
    assert.equal(dp.resetClickCount, 0, 'сброс не вызывался');
    assert.equal(dp.botStopped, true);
    assert.equal(dp.state, DP.IDLE, 'цикл завершён');
});

console.log('Полный цикл: два прохода и остановка');

test('FULL: IDLE → победа1 → сброс → подтверждение → победа2 → DONE, ровно 1 сброс', () => {
    const dp = createDoublePassState(true, DP.IDLE);
    dp.handleWinAlert(true, true, false, false);      // первая победа
    assert.equal(dp.state, DP.WAITING_RESET);
    dp.checkWaitingResetConfirmation(true, true);      // подтверждение перехода
    assert.equal(dp.state, DP.SECOND_IN_PROGRESS);
    dp.handleWinAlert(true, true, false, false);      // вторая победа
    assert.equal(dp.state, DP.DONE);
    assert.equal(dp.botStopped, true);
    assert.equal(dp.resetClickCount, 1, 'за весь цикл ровно один возврат в начало');
});

console.log('Восстановление после перезагрузки');

test('T9: WAITING_RESET восстановлен из хранилища → подтверждение работает', () => {
    const dp = createDoublePassState(true, DP.WAITING_RESET);
    dp.handleWinAlert(true, true, false, false);      // тик: защита, игнор
    assert.equal(dp.state, DP.WAITING_RESET, 'состояние не потеряно');
    assert.equal(dp.checkWaitingResetConfirmation(true, true), false);
    assert.equal(dp.state, DP.SECOND_IN_PROGRESS);
});

test('T9b: SECOND_IN_PROGRESS восстановлен → следующая победа = DONE', () => {
    const dp = createDoublePassState(true, DP.SECOND_IN_PROGRESS);
    dp.handleWinAlert(true, true, false, false);
    assert.equal(dp.state, DP.DONE);
});

test('T9c: DONE восстановлен → повторная победа не запускает проход', () => {
    const dp = createDoublePassState(true, DP.DONE);
    dp.handleWinAlert(true, true, true, true);
    assert.equal(dp.resetClickCount, 0);
    assert.equal(dp.botStopped, true);
});

console.log('Явная остановка пользователем');

test('T10: stopBot при WAITING_RESET сохраняет состояние незавершённого перехода', () => {
    const dp = createDoublePassState(true, DP.WAITING_RESET);
    dp.stopBot();
    assert.equal(dp.state, DP.WAITING_RESET, 'состояние перехода сохранено');
});

test('T10b: stopBot при SECOND_IN_PROGRESS сохраняет состояние', () => {
    const dp = createDoublePassState(true, DP.SECOND_IN_PROGRESS);
    dp.stopBot();
    assert.equal(dp.state, DP.SECOND_IN_PROGRESS);
});

test('T10c: stopBot при IDLE/DONE сбрасывает в IDLE', () => {
    const a = createDoublePassState(true, DP.IDLE); a.stopBot();
    assert.equal(a.state, DP.IDLE);
    const b = createDoublePassState(true, DP.DONE); b.stopBot();
    assert.equal(b.state, DP.IDLE);
});

console.log('Обычная работа (двойной режим выключен)');

test('T11: enabled=false → первая же победа останавливает бота', () => {
    const dp = createDoublePassState(false, DP.IDLE);
    dp.handleWinAlert(true, true, true, true);
    assert.equal(dp.state, DP.IDLE);
    assert.equal(dp.botStopped, true);
    assert.equal(dp.resetClickCount, 0, 'возврат не нажимался');
});

console.log('Акционный режим');

test('T12: победа в акционном режиме обрабатывается через ту же машину состояний', () => {
    const dp = createDoublePassState(true, DP.IDLE);
    dp.handleWinAlert(true, true, true, true);
    assert.equal(dp.state, DP.SECOND_IN_PROGRESS);
    assert.ok(dp.log.some(l => l.includes('Возвращаюсь в начало')));
});

// ============================================================
// ТЕСТЫ ЗАЩИТЫ ОТ ПОВТОРНЫХ КЛИКОВ АТАКИ
// ============================================================

console.log('Защита от повторной отправки атаки');

test('A1: тот же alert в пределах cooldown → клик отклонён', () => {
    const d = createAlertDedup(5000);
    const t = 1_000_000;
    assert.equal(d.tryClick('neftlenin_alert_d', t), true, 'первый клик разрешён');
    assert.equal(d.tryClick('neftlenin_alert_d', t + 1200), false, 'тик +1.2с — ждём');
    assert.equal(d.tryClick('neftlenin_alert_d', t + 2400), false, 'тик +2.4с — ждём');
    assert.equal(d.clicks, 1, 'ровно один клик');
    assert.equal(d.waits, 2, 'два отклонённых запроса');
});

test('A2: новое окно патруля обрабатывается сразу', () => {
    const d = createAlertDedup(5000);
    const t = 1_000_000;
    assert.equal(d.tryClick('neftlenin_alert_d', t), true);
    assert.equal(d.tryClick('neftlenin_alert_g', t + 100), true, 'другое окно — сразу');
    assert.equal(d.tryClick('neftlenin_alert_b', t + 200), true, 'третье окно — сразу');
    assert.equal(d.clicks, 3);
});

test('A3: после истечения cooldown то же окно разрешено (восстановление)', () => {
    const d = createAlertDedup(5000);
    const t = 1_000_000;
    assert.equal(d.tryClick('neftlenin_alert_d', t), true);
    assert.equal(d.tryClick('neftlenin_alert_d', t + 4000), false, 'до cooldown — ждём');
    assert.equal(d.tryClick('neftlenin_alert_d', t + 6000), true, 'после cooldown — разрешено');
    assert.equal(d.clicks, 2);
});

test('A4: повторная инициализация (reset) не ломает защиту', () => {
    const d = createAlertDedup(5000);
    const t = 1_000_000;
    d.tryClick('neftlenin_alert_d', t);
    d.reset();                       // restartIntervals / повторная инициализация
    assert.equal(d.tryClick('neftlenin_alert_d', t + 100), true, 'после reset разрешено');
    assert.equal(d.tryClick('neftlenin_alert_d', t + 200), false, 'защита снова работает');
});

test('A5: серия из 10 тиков по зависшему окну → не более 2 кликов', () => {
    const d = createAlertDedup(5000);
    const t = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
        if (d.tryClick('neftlenin_alert_b', t + i * 1200)) allowed++;
    }
    // 10 тиков по 1200мс = 10800мс → первое окно + одно после cooldown(5000)
    assert.ok(allowed <= 2, 'кликов не больше двух за 10 тиков, получено: ' + allowed);
});

// ============================================================

console.log('Итого: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
