'use strict';
// Протокольные тесты сервера: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// Временная копия public/ с реальным (тихим) wav-файлом, чтобы проверить выдачу звуков
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-'));
fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
function wav() {
  const n = 800, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
fs.writeFileSync(path.join(tmp, 'sounds', 'laugh.mp3'), wav()); // расширение важно, содержимое для сервера не критично
process.env.PUBLIC_DIR = tmp;
process.env.ROOM_TTL_MS = '300';
const { server, wss, rooms } = require('../server');

let port;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); })));
test.after(() => { for (const c of wss.clients) c.terminate(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function client(room, extra = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { ws, msgs: [], waiters: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => !w(m));
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.next = (pred, ms = 1500) => new Promise((res, rej) => {
    const hit = c.msgs.find(pred);
    if (hit) { c.msgs.splice(c.msgs.indexOf(hit), 1); return res(hit); }
    const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
    c.waiters.push((m) => { if (!pred(m)) return false; clearTimeout(t); c.msgs.splice(c.msgs.indexOf(m), 1); res(m); return true; });
  });
  c.open = new Promise((r) => ws.on('open', r));
  c.join = async (name, more = {}) => { await c.open; c.send({ type: 'join', room, name, ...extra, ...more }); return c.next((m) => m.type === 'init' || m.type === 'error'); };
  c.count = (type) => c.msgs.filter((m) => m.type === type).length;
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((res, rej) => require('http').get(`http://127.0.0.1:${port}${p}`, (r) => { const ch = []; r.on('data', (d) => ch.push(d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(ch) })); }).on('error', rej));

test('join, init и список пользователей', async () => {
  const a = client('TEST1'); const init = await a.join('Аня', { cid: 'aaaaaaaa1', avatar: { p: 3 } });
  assert.equal(init.type, 'init');
  assert.equal(init.users[0].av, 'p3');
  assert.equal(init.you, 'aaaaaaaa1');
  assert.ok(init.embedHosts.includes('tapeop.dev'));
  const b = client('TEST1'); await b.join('Боря', { cid: 'bbbbbbbb1' });
  const users = await a.next((m) => m.type === 'users' && m.users.length === 2);
  assert.equal(users.users.length, 2);
  a.ws.close(); b.ws.close();
});

test('неверный код комнаты и переполнение', async () => {
  const a = client('x'); const r = await a.join('A'); assert.equal(r.type, 'error');
  const cs = [];
  for (let i = 0; i < 20; i++) { const c = client('FULL1'); await c.join('u' + i, { cid: 'full' + String(i).padStart(6, '0') }); cs.push(c); }
  const over = client('FULL1'); const e = await over.join('late', { cid: 'lateXXXXXXX' });
  assert.equal(e.type, 'error');
  [a, over, ...cs].forEach((c) => c.ws.close());
});

test('чат: история, fly-режим не сохраняется, eid растёт, XSS остаётся текстом', async () => {
  const a = client('CHAT1'); await a.join('A', { cid: 'chatAAAAAA' });
  const b = client('CHAT1'); await b.join('B', { cid: 'chatBBBBBB' });
  a.send({ type: 'chat', text: '<img src=x onerror=alert(1)>' });
  const m1 = await b.next((m) => m.type === 'chat');
  assert.equal(m1.text, '<img src=x onerror=alert(1)>'); // сервер не меняет текст, клиент вставляет через textContent
  a.send({ type: 'chat', mode: 'fly', text: 'летит', color: 3 });
  const m2 = await b.next((m) => m.type === 'chat' && m.mode === 'fly');
  assert.equal(m2.color, 3); assert.ok(m2.eid > m1.eid);
  const c = client('CHAT1'); const init = await c.join('C', { cid: 'chatCCCCCC' });
  assert.equal(init.history.length, 1);
  assert.equal(init.eid, m2.eid);
  [a, b, c].forEach((x) => x.ws.close());
});

test('реакции: валидация, звук только по привязке, личный интервал звука', async () => {
  const a = client('REACT1'); await a.join('A', { cid: 'reactAAAAA' });
  const b = client('REACT1'); await b.join('B', { cid: 'reactBBBBB' });
  a.send({ type: 'reaction', emoji: 'не-эмодзи' });
  a.send({ type: 'reaction', emoji: '😂' });
  const r1 = await b.next((m) => m.type === 'reaction');
  assert.equal(r1.emoji, '😂'); assert.equal(r1.sound, 'laugh'); assert.equal(r1.id, 'reactAAAAA');
  a.send({ type: 'reaction', emoji: '😂' }); // сразу же: звук отсекается, эмодзи нет
  const r2 = await b.next((m) => m.type === 'reaction');
  assert.equal(r2.sound, null);
  a.send({ type: 'reaction', emoji: '🔥' }); // привязка есть, файла нет -> звука нет
  const r3 = await b.next((m) => m.type === 'reaction');
  assert.equal(r3.emoji, '🔥'); assert.equal(r3.sound, null);
  assert.ok(r1.eid < r2.eid && r2.eid < r3.eid);
  [a, b].forEach((x) => x.ws.close());
});

test('реакции: защита от спама', async () => {
  const a = client('SPAM1'); await a.join('A', { cid: 'spamAAAAAA' });
  const b = client('SPAM1'); await b.join('B', { cid: 'spamBBBBBB' });
  for (let i = 0; i < 60; i++) a.send({ type: 'reaction', emoji: '👏' });
  await sleep(400);
  const got = b.count('reaction');
  assert.ok(got >= 4 && got <= 8, `получено ${got}`);
  const withSound = b.msgs.filter((m) => m.type === 'reaction' && m.sound).length;
  assert.ok(withSound <= 1, 'звук не должен спамиться');
  [a, b].forEach((x) => x.ws.close());
});

test('общий лимит звуков на комнату', async () => {
  const room = 'ROOMLIM1';
  const cs = [];
  for (let i = 0; i < 12; i++) { const c = client(room); await c.join('u' + i, { cid: 'lim' + String(i).padStart(8, '0') }); cs.push(c); }
  for (const c of cs) c.send({ type: 'reaction', emoji: '😂' });
  await sleep(400);
  const seen = cs[0].msgs.filter((m) => m.type === 'reaction');
  assert.equal(seen.length, 12);
  assert.equal(seen.filter((m) => m.sound).length, 8);
  cs.forEach((c) => c.ws.close());
});

test('управление плеером: ретрансляция без эха, валидация', async () => {
  const a = client('CTRL1'); await a.join('A', { cid: 'ctrlAAAAAA' });
  const b = client('CTRL1'); await b.join('B', { cid: 'ctrlBBBBBB' });
  a.send({ type: 'control', action: 'bad', time: 1 });
  a.send({ type: 'control', action: 'seek', time: -5 });
  a.send({ type: 'control', action: 'seek', time: 'x' });
  a.send({ type: 'control', action: 'play', time: 12 });
  const s = await b.next((m) => m.type === 'state');
  assert.equal(s.action, 'play'); assert.equal(s.time, 12); assert.equal(s.playing, true);
  assert.equal(a.count('state'), 0);
  const c = client('CTRL1'); const init = await c.join('C', { cid: 'ctrlCCCCCC' });
  assert.equal(init.state.playing, true); assert.ok(init.state.time >= 12);
  [a, b, c].forEach((x) => x.ws.close());
});

test('источники: допустимые и запрещённые', async () => {
  const a = client('SRC1'); await a.join('A', { cid: 'srcAAAAAAA' });
  const ok = [
    { type: 'yt', id: 'dQw4w9WgXcQ' }, { type: 'vimeo', id: '76979871', h: 'abcdef123456' },
    { type: 'rutube', id: 'a'.repeat(32) }, { type: 'url', url: 'https://x.test/v.mp4' },
    { type: 'url', url: 'https://x.test/live.m3u8' },
    { type: 'embed', url: 'https://tapeop.dev/watch/123' }, { type: 'embed', url: 'https://www.tapeop.dev/x' },
  ];
  for (const src of ok) {
    a.send({ type: 'setSource', source: src });
    const m = await a.next((x) => x.type === 'source');
    assert.equal(m.source.type, src.type);
    await sleep(1100); // бакет setSource: 1/с
  }
  const bad = [
    { type: 'embed', url: 'https://evil.example/x' }, { type: 'embed', url: 'http://tapeop.dev/x' },
    { type: 'embed', url: 'https://tapeop.dev.evil.example/x' }, { type: 'embed', url: 'https://user:pw@tapeop.dev/x' },
    { type: 'url', url: 'javascript:alert(1)' }, { type: 'yt', id: 'short' }, { type: 'vimeo', id: 'abc' },
    { type: 'rutube', id: 'zz' }, { type: 'x' }, null, 'str',
  ];
  await sleep(1200);
  for (const src of bad) { a.send({ type: 'setSource', source: src }); await sleep(30); }
  await sleep(200);
  assert.equal(a.count('source'), 0, 'запрещённые источники не должны приниматься');
  const b = client('SRC1'); const init = await b.join('B', { cid: 'srcBBBBBBB' });
  assert.ok(init.recent.length >= 1 && init.recent.length <= 6);
  [a, b].forEach((x) => x.ws.close());
});

test('аватарки: проверка содержимого, выдача по HTTP', async () => {
  const a = client('AVA1'); await a.join('A', { cid: 'avaAAAAAAA' });
  a.send({ type: 'profile', avatar: { data: PNG } });
  const u = await a.next((m) => m.type === 'users');
  assert.match(u.users[0].av, /^h[0-9a-f]{10}$/);
  const res = await get('/a/AVA1/avaAAAAAAA');
  assert.equal(res.status, 200); assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal((await get('/a/AVA1/nobodyxxxx')).status, 404);
  await sleep(2100);
  a.send({ type: 'profile', avatar: { data: Buffer.from('<script>alert(1)</script>'.repeat(3)).toString('base64') } });
  const e = await a.next((m) => m.type === 'error');
  assert.match(e.message, /Аватарка/);
  await sleep(2100);
  a.send({ type: 'profile', avatar: { data: Buffer.alloc(40000, 1).toString('base64') } });
  assert.equal((await a.next((m) => m.type === 'error')).type, 'error');
  await sleep(2100);
  a.send({ type: 'profile', avatar: { p: 99 } });
  assert.equal((await a.next((m) => m.type === 'error')).type, 'error');
  a.ws.close();
});

test('переподключение: старый сокет заменяется тихо, resume возвращает источник', async () => {
  const a = client('RECON1'); await a.join('A', { cid: 'recAAAAAAA' });
  const b = client('RECON1'); await b.join('B', { cid: 'recBBBBBBB' });
  const a2 = client('RECON1'); const init = await a2.join('A', { cid: 'recAAAAAAA' });
  assert.equal(init.users.length, 2, 'без дублей');
  await sleep(150);
  assert.equal(b.msgs.filter((m) => m.type === 'sys').length, 0, 'переподключение A не должно давать «вышел/зашёл» в чате');
  b.ws.close(); a2.ws.close(); a.ws.close();
  // новая комната после «перезапуска»: первый вошедший возвращает источник
  const c = client('RESUME1');
  const i2 = await c.join('C', { cid: 'resCCCCCCC', resume: { source: { type: 'yt', id: 'dQw4w9WgXcQ' }, time: 77 } });
  assert.equal(i2.source.id, 'dQw4w9WgXcQ'); assert.equal(Math.round(i2.state.time), 77); assert.equal(i2.state.playing, false);
  const d = client('RESUME1'); const i3 = await d.join('D', { cid: 'resDDDDDDD', resume: { source: { type: 'yt', id: 'AAAAAAAAAAA' }, time: 5 } });
  assert.equal(i3.source.id, 'dQw4w9WgXcQ', 'resume не перезаписывает живую комнату');
  [c, d].forEach((x) => x.ws.close());
});

test('сервер проверяет число и тип сообщений, не падает на мусоре', async () => {
  const a = client('JUNK1'); await a.join('A', { cid: 'junkAAAAAA' });
  a.ws.send('not json'); a.ws.send('null'); a.ws.send('[]'); a.ws.send(JSON.stringify({ type: 5 }));
  a.send({ type: 'chat', text: { a: 1 } }); a.send({ type: 'reaction', emoji: { x: 1 } }); a.send({ type: 'profile', name: { x: 1 } });
  a.send({ type: 'ping', t: 5 });
  const p = await a.next((m) => m.type === 'pong'); assert.equal(p.t, 5);
  a.ws.close();
});

test('комната освобождается после выхода всех (TTL)', async () => {
  const a = client('TTL1'); await a.join('A', { cid: 'ttlAAAAAAA' });
  assert.ok(rooms.has('TTL1'));
  a.ws.close();
  await sleep(700);
  assert.equal(rooms.has('TTL1'), false);
});

test('HTTP: статика, безопасность, healthz', async () => {
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/healthz')).body.toString(), 'ok');
  const man = JSON.parse((await get('/api/sounds')).body);
  assert.equal(man.sounds.laugh.url, '/sounds/laugh.mp3'); assert.equal(man.bindings['😂'], 'laugh'); assert.equal(man.bindings['🔥'], undefined);
  assert.equal((await get('/sounds/laugh.mp3')).headers['content-type'], 'audio/mpeg');
  assert.equal((await get('/../server.js')).status, 404);
  assert.equal((await get('/api/nope.json')).status, 404);
  assert.equal((await get('/%2e%2e/server.js')).status, 404);
  assert.equal((await get('/lib/media.js')).status, 404);
  assert.equal((await get('/.git/config')).status, 404);
  assert.equal((await get('/index.html')).headers['content-security-policy'].includes("frame-ancestors 'self'"), true);
});
