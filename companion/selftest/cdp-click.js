// Тест: кликает через CDP и читает счётчики доверенных событий страницы.
// Использование: node cdp-click.js [порт]
const http = require('http');
const PORT = Number(process.argv[2] || 9333);

function get(p) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await get('/json/list');
  const page = list.find(t => t.type === 'page' && /mw-click-test/.test(decodeURIComponent(t.url)));
  if (!page) throw new Error('test page not found');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1; const pend = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = id++; pend.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id).resolve(m.result || m); pend.delete(m.id); }
  };
  await new Promise(r => ws.onopen = r);

  const readCounters = async () => {
    const r = await send('Runtime.evaluate', {
      expression: `document.title`, returnByValue: true
    });
    return r.result.value;
  };

  const click = async () => {
    for (let i = 6; i >= 1; i--) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 75 - i * 10, y: 250 - i * 6, buttons: 0 });
      await sleep(12);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 75, y: 250, buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 75, y: 250, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 75, y: 250, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(350);
  };

  const before = await readCounters();
  await click();
  const after = await readCounters();
  console.log(JSON.stringify({ port: PORT, before, after }));
  ws.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
