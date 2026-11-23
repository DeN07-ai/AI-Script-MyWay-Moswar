#!/usr/bin/env node
/**
 * MyWay Moswar Companion — локальный сервер аппаратных кликов.
 *
 * Зачем:
 *   Игра проверяет event.isTrusted у клика по кнопке старта боя. Событие,
 *   созданное из JS (new MouseEvent / dispatchEvent / el.click()), всегда
 *   имеет isTrusted === false и отвергается сервером. Единственный честный
 *   способ — родить событие ВНЕ страницы: на уровне ОС (CoreGraphics) или
 *   через Chrome DevTools Protocol. Тогда браузер помечает его доверенным,
 *   и скрипту не нужно ничего подделывать в JS.
 *
 * Платформы:
 *   macOS   — основной путь: нативный кликер bin/mw_clicker_mac (Accessibility
 *             читает реальную геометрию viewport, CoreGraphics шлёт событие).
 *             Перезапуск Chrome НЕ требуется.
 *   Windows — основной путь: CDP. Браузер и сервер поднимает
 *             start-companion-win.bat (отдельный профиль, порт 9222).
 *             Запасной путь: клик через user32.dll из PowerShell.
 *
 * Зависимости: только Node.js 18+ (внешние npm-пакеты не нужны). На macOS
 * дополнительно нужен clang — ставится вместе с Xcode Command Line Tools.
 *
 * Протокол (слушает 127.0.0.1:3999):
 *   GET  /status  → {ok, mode, axTrusted, chromePid, window, cdp, clickReady, ...}
 *   POST /click   → тело {clientX, clientY, dpr, hint, screenX, screenY, url}
 *                   ответ  {success, mode, ...} | {success:false, error}
 */

const http = require('http');
const { execFile, execFileSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.MW_COMPANION_PORT || 3999);
const CDP_PORTS = [9222, 9223, 9224];
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const VERSION = '2.0';

const SRC_C = path.join(__dirname, 'macos_clicker.c');
const BIN_DIR = path.join(__dirname, 'bin');
const CLICKER = path.join(BIN_DIR, IS_MAC ? 'mw_clicker_mac' : 'mw_clicker.exe');

const log = (...a) => console.log('[Companion]', ...a);
const warn = (...a) => console.warn('[Companion]', ...a);

/* ---------------- НАТИВНЫЙ КЛИКЕР: СБОРКА ---------------- */

/**
 * Компилируем кликер сами, если бинарника нет или он старее исходника.
 * Пользователю не нужно ничего собирать вручную.
 */
function ensureClicker() {
    if (!IS_MAC) return { ready: false, error: 'native clicker is macOS-only' };
    if (!fs.existsSync(SRC_C)) return { ready: false, error: 'macos_clicker.c not found' };

    try {
        const srcMtime = fs.statSync(SRC_C).mtimeMs;
        const binMtime = fs.existsSync(CLICKER) ? fs.statSync(CLICKER).mtimeMs : 0;
        if (binMtime >= srcMtime) return { ready: true };

        if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
        log('Компиляция нативного кликера (происходит один раз)…');
        execFileSync('clang', [
            '-framework', 'ApplicationServices',
            '-framework', 'CoreGraphics',
            '-framework', 'CoreFoundation',
            '-Wall', '-O2', SRC_C, '-o', CLICKER,
        ], { stdio: 'pipe' });
        log('Нативный кликер готов:', CLICKER);
        return { ready: true, compiled: true };
    } catch (e) {
        const msg = (e.stderr && e.stderr.toString().split('\n')[0]) || e.message;
        warn('Не удалось собрать кликер:', msg);
        return { ready: false, error: 'compile_failed: ' + msg };
    }
}

function runClicker(args, timeoutMs) {
    return new Promise((resolve) => {
        if (!fs.existsSync(CLICKER)) return resolve({ ok: false, error: 'clicker_missing' });
        execFile(CLICKER, args, {
            timeout: timeoutMs || 6000,
            env: Object.assign({}, process.env, { MW_CHROME_PID: String(chromePid() || 0) }),
        }, (err, stdout) => {
            const text = (stdout || '').trim();
            try {
                resolve(JSON.parse(text));
            } catch (_) {
                resolve({ ok: false, error: err ? err.message : 'bad_output', raw: text.slice(0, 200) });
            }
        });
    });
}

/* ---------------- ПОИСК ПРОЦЕССА БРАУЗЕРА ---------------- */

let _pid = 0;
let _pidAt = 0;

/**
 * Главный (не вспомогательный) процесс браузера. Именно у него macOS
 * запрашивает дерево Accessibility. Кэшируем на 10 секунд, чтобы не
 * дёргать pgrep на каждом клике.
 */
function chromePid() {
    const now = Date.now();
    if (_pid && now - _pidAt < 10000) return _pid;
    _pid = 0;
    try {
        if (IS_MAC) {
            // Вспомогательные процессы называются "Google Chrome Helper", поэтому
            // точное имя отдаёт только главный процесс.
            _pid = Number(execFileSync('pgrep', ['-x', 'Google Chrome'], { timeout: 1500 })
                .toString().split('\n')[0]) || 0;
            if (!_pid) {
                _pid = Number(execFileSync('pgrep', ['-x', 'Yandex Browser'], { timeout: 1500 })
                    .toString().split('\n')[0]) || 0;
            }
        } else if (IS_WIN) {
            const out = execFileSync(
                'tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'], { timeout: 2000 }
            ).toString();
            const m = out.match(/"chrome\.exe","(\d+)"/);
            _pid = m ? Number(m[1]) : 0;
        }
    } catch (_) {}
    _pidAt = now;
    return _pid;
}

/* ---------------- CDP ---------------- */

function fetchJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs || 700 }, (res) => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function findCdpTarget(urlHint) {
    for (const port of CDP_PORTS) {
        try {
            const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
            if (!Array.isArray(list)) continue;
            const pages = list.filter(t => t.type === 'page' && /moswar|мосвар/i.test(t.url || ''));
            const target =
                (urlHint && pages.find(t => t.url === urlHint)) ||
                pages.find(t => /travel2/i.test(t.url)) ||
                pages[0];
            if (target && target.webSocketDebuggerUrl) return { port, target };
        } catch (_) {}
    }
    return null;
}

/**
 * Клик через CDP. Обязательно с цепочкой mouseMoved: игра собирает доказательство
 * «человеческого» действия внутри своих capture-слушателей, и без предыдущих
 * move-событий это доказательство не формируется.
 */
function clickViaCDP(wsUrl, clientX, clientY) {
    return new Promise((resolve) => {
        if (typeof WebSocket === 'undefined') {
            return resolve({ success: false, error: 'node_websocket_unavailable' });
        }
        let ws;
        try { ws = new WebSocket(wsUrl); } catch (e) { return resolve({ success: false, error: e.message }); }

        const done = (r) => { try { ws.close(); } catch (_) {} resolve(r); };
        const timer = setTimeout(() => done({ success: false, error: 'cdp_timeout' }), 3000);
        const finish = (r) => { clearTimeout(timer); done(r); };

        ws.onopen = async () => {
            const steps = [];
            // 12 точек по дуге к цели — имитация реального подведения курсора.
            for (let i = 12; i >= 1; i--) {
                const t = i / 12;
                const x = clientX - 60 * t + (Math.random() * 6 - 3);
                const y = clientY - 35 * t + (Math.random() * 6 - 3);
                steps.push({ type: 'mouseMoved', x: Math.round(x), y: Math.round(y), buttons: 0 });
            }
            steps.push({ type: 'mouseMoved', x: clientX, y: clientY, buttons: 0 });
            steps.push({ type: 'mousePressed', x: clientX, y: clientY, button: 'left', buttons: 1, clickCount: 1 });
            steps.push({ type: 'mouseReleased', x: clientX, y: clientY, button: 'left', buttons: 0, clickCount: 1 });

            let id = 1;
            for (const s of steps) {
                try { ws.send(JSON.stringify({ id: id++, method: 'Input.dispatchMouseEvent', params: s })); }
                catch (e) { return finish({ success: false, error: 'cdp_send: ' + e.message }); }
                await new Promise(r => setTimeout(r, s.type === 'mouseMoved' ? 12 : 60));
            }
            setTimeout(() => finish({ success: true, mode: 'cdp' }), 120);
        };
        ws.onerror = (e) => finish({ success: false, error: (e && e.message) || 'ws_error' });
    });
}

/* ---------------- WINDOWS: OS-КЛИК ---------------- */

function clickOSWin(x, y) {
    const ps = [
        'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
        '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
        '[DllImport("user32.dll")] public static extern void mouse_event(int f,int dx,int dy,int b,int e);\'',
        '-Name N -Namespace M;',
        '[M.N]::SetProcessDPIAware() | Out-Null;',
        `[M.N]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null;`,
        'Start-Sleep -Milliseconds 40;',
        '[M.N]::mouse_event(2,0,0,0,0);',
        'Start-Sleep -Milliseconds 80;',
        '[M.N]::mouse_event(4,0,0,0,0);',
    ].join(' ');
    return new Promise((resolve) => {
        exec(`powershell.exe -NoProfile -NonInteractive -Command "${ps}"`, (err) => {
            if (err) resolve({ success: false, error: err.message });
            else resolve({ success: true, mode: 'os_win' });
        });
    });
}

/* ---------------- /click ---------------- */

/**
 * Главная точка входа. Приоритет путей:
 *   macOS:   нативный AX/CoreGraphics клик → (при отказе) CDP
 *   Windows: CDP → OS-клик по экранным координатам
 * Если ни один путь не сработал, возвращаем ошибку — скрипт не должен
 * слать заведомо отвергнутый запрос на старт боя.
 */
async function handleClick(body) {
    const clientX = Math.round(Number(body.clientX));
    const clientY = Math.round(Number(body.clientY));
    const dpr = Number(body.dpr) || (IS_MAC ? 2 : 1);
    const hint = typeof body.hint === 'string' ? body.hint.slice(0, 120) : '';
    const url = typeof body.url === 'string' ? body.url : '';
    /* CSS-размеры окна нужны, чтобы посчитать реальный масштаб страницы
     * (80% / 100% / 110%) напрямую из геометрии, а не полагаясь на dpr. */
    const cssW = Number(body.cssWidth) || 0;
    const cssH = Number(body.cssHeight) || 0;

    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
        return { success: false, error: 'bad_coordinates' };
    }

    if (IS_MAC) {
        const r = await runClicker([
            '--click', String(clientX), String(clientY), String(dpr),
            hint, String(cssW), String(cssH),
        ]);
        if (r.ok) {
            log(`✔ Аппаратный клик (viewport ${r.viewport ? r.viewport.w + '×' + r.viewport.h : '?'}, zoom ${r.zoom})`);
            return { success: true, mode: 'ax_mac', detail: r };
        }
        warn('AX-клик не удался:', r.error, '— пробую CDP');
        const cdp = await findCdpTarget(url);
        if (cdp) {
            const c = await clickViaCDP(cdp.target.webSocketDebuggerUrl, clientX, clientY);
            if (c.success) return { success: true, mode: 'cdp', port: cdp.port, axError: r.error };
            return { success: false, error: c.error, axError: r.error };
        }
        return { success: false, error: r.error };
    }

    if (IS_WIN) {
        const cdp = await findCdpTarget(url);
        if (cdp) {
            const c = await clickViaCDP(cdp.target.webSocketDebuggerUrl, clientX, clientY);
            if (c.success) return { success: true, mode: 'cdp', port: cdp.port };
            warn('CDP не сработал:', c.error, '— перехожу на OS-клик');
        }
        const sx = Math.round(Number(body.screenX));
        const sy = Math.round(Number(body.screenY));
        if (Number.isFinite(sx) && Number.isFinite(sy)) return await clickOSWin(sx, sy);
        return { success: false, error: cdp ? 'cdp_failed' : 'no_cdp_and_no_screen' };
    }

    return { success: false, error: 'unsupported_platform: ' + process.platform };
}

/* ---------------- /status ---------------- */

async function handleStatus() {
    const pid = chromePid();
    const out = {
        ok: true,
        name: 'MyWay Moswar Companion',
        version: VERSION,
        platform: process.platform,
        arch: process.arch,
        port: PORT,
        chromePid: pid || null,
        mode: IS_MAC ? 'ax_mac' : (IS_WIN ? 'cdp|os_win' : 'unsupported'),
    };

    if (IS_MAC) {
        const built = ensureClicker();
        out.clicker = built;
        if (built.ready) {
            const st = await runClicker(['--status'], 3000);
            out.axTrusted = !!(st && st.trusted);
            out.displays = (st && st.displays) || [];
            if (pid) {
                const w = await runClicker(['--windows'], 6000);
                out.window = w.ok ? (w.windows || [])[0] || null : { error: w.error };
            }
        }
    }

    const cdp = await findCdpTarget();
    out.cdp = cdp ? { connected: true, port: cdp.port, tab: cdp.target.title } : { connected: false };

    // Готов ли компаньон реально кликать прямо сейчас.
    if (IS_MAC) {
        out.clickReady = !!(out.clicker && out.clicker.ready && out.axTrusted && pid &&
            out.window && !out.window.error);
    } else if (IS_WIN) {
        // Готов только при вкладке Мосвара на отладочном порту.
        // Сам факт Windows не означает, что клик по кнопке попадёт.
        out.clickReady = !!cdp;
    } else {
        out.clickReady = false;
    }
    return out;
}

/* ---------------- HTTP ---------------- */

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) {
        handleStatus().then(r => send(200, r)).catch(e => send(500, { ok: false, error: e.message }));
        return;
    }

    if (req.method === 'POST' && req.url === '/click') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
        req.on('end', () => {
            let params;
            try { params = JSON.parse(body || '{}'); }
            catch (e) { return send(400, { success: false, error: 'bad_json' }); }
            handleClick(params).then(r => send(r.success ? 200 : 502, r))
                .catch(e => send(500, { success: false, error: e.message }));
        });
        return;
    }

    send(404, { ok: false, error: 'not_found' });
});

function main() {
    if (IS_MAC) ensureClicker();
    server.listen(PORT, '127.0.0.1', () => {
        log('==================================================');
        log(`MyWay Moswar Companion v${VERSION} · порт ${PORT}`);
        log(`Платформа: ${process.platform} (${process.arch})`);
        log(`Статус: http://127.0.0.1:${PORT}/status`);
        log('==================================================');
    });
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            warn(`Порт ${PORT} уже занят — скорее всего Companion уже запущен. Выход.`);
            process.exit(0);
        }
        throw e;
    });
}

main();
