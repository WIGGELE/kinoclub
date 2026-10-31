'use strict';
// Киноклуб: HTTP (статика, аватарки, список звуков) + WebSocket (комнаты) на одном порту.
// Всё состояние хранится в памяти: подходит для Render Free, где диск не сохраняется между перезапусками.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createStatic } = require('./lib/static');
const media = require('./lib/media');

const { clean, validSource, sameSource, parseAvatar, avatarRef } = media;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // Render требует слушать 0.0.0.0, а не localhost
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 10 * 60 * 1000; // пустая комната живёт столько
const LEFT_GRACE_MS = 3000;       // «вышел(а)» в чате показываем не сразу: вдруг это просто переподключение
const MAX_PER_ROOM = 20;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 300;
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 600;
const MAX_TIME = 7 * 24 * 3600;   // верхняя граница позиции видео, сек
const SOUND_GAP_MS = 1200;        // один участник: звук эмодзи не чаще
const ROOM_SOUNDS = 8;            // вся комната: не больше стольких звуков...
const ROOM_SOUNDS_WINDOW = 3000;  // ...за такой промежуток, мс

const EPOCH = crypto.randomBytes(6).toString('hex'); // меняется при каждом запуске процесса
const EMOJI = media.loadEmoji(PUBLIC_DIR);
const sounds = media.createSounds(PUBLIC_DIR);
const serveStatic = createStatic(PUBLIC_DIR);
const rooms = new Map();
let eidCounter = 0; // сквозной номер события: растёт при любых событиях, поэтому повторы легко отсеять

/* ---------- утилиты ---------- */
const bucket = (cap, perSec) => ({ n: cap, t: Date.now(), cap, rate: perSec });
function take(b) {
  const now = Date.now();
  b.n = Math.min(b.cap, b.n + ((now - b.t) / 1000) * b.rate);
  b.t = now;
  if (b.n < 1) return false;
  b.n -= 1;
  return true;
}
const pos = (r) => (r.playing ? r.time + (Date.now() - r.at) / 1000 : r.time);
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function broadcast(r, o, except) {
  const s = JSON.stringify(o); // сериализуем один раз на всех
  for (const c of r.clients.values()) if (c !== except && c.readyState === 1) c.send(s);
}
const userList = (r) => [...r.clients.values()].map((c) => ({ id: c.id, name: c.name, av: c.avRef }));
const nextEid = (r) => (r.lastEid = ++eidCounter);
const presetOnly = (ref) => (ref && ref[0] === 'p' ? ref : undefined);

/* ---------- комнаты ---------- */
function createRoom(code) {
  const r = {
    code, source: null, playing: false, time: 0, at: Date.now(),
    clients: new Map(), history: [], recent: [], lastEid: 0,
    timer: null, left: new Map(), soundLog: [], lastCountdown: 0,
  };
  rooms.set(code, r);
  return r;
}
function dropRoom(r) {
  if (r.clients.size) return;
  clearTimeout(r.timer);
  for (const t of r.left.values()) clearTimeout(t);
  r.left.clear();
  if (rooms.get(r.code) === r) rooms.delete(r.code);
}
function leave(ws) {
  const r = ws.room;
  if (!r) return;
  ws.room = null;
  if (r.clients.get(ws.id) === ws) r.clients.delete(ws.id);
  else return; // этот сокет уже заменён новым
  if (r.clients.size === 0) {
    for (const t of r.left.values()) clearTimeout(t);
    r.left.clear();
    clearTimeout(r.timer);
    r.timer = setTimeout(() => dropRoom(r), ROOM_TTL_MS);
    r.timer.unref();
    return;
  }
  broadcast(r, { type: 'users', users: userList(r) });
  const name = ws.name;
  const t = setTimeout(() => {
    r.left.delete(ws.id);
    if (r.clients.size) broadcast(r, { type: 'sys', text: `${name} вышел(а)` });
  }, LEFT_GRACE_MS);
  t.unref();
  clearTimeout(r.left.get(ws.id));
  r.left.set(ws.id, t);
}

function pushRecent(r, src) {
  if (src.type === 'file') return;
  r.recent = [src, ...r.recent.filter((s) => !sameSource(s, src))].slice(0, 6);
}

function roomSoundOk(r, now) {
  while (r.soundLog.length && now - r.soundLog[0] > ROOM_SOUNDS_WINDOW) r.soundLog.shift();
  if (r.soundLog.length >= ROOM_SOUNDS) return false;
  r.soundLog.push(now);
  return true;
}

/* ---------- обработка сообщений ---------- */
function join(ws, m) {
  if (ws.room) return;
  const code = typeof m.room === 'string' ? m.room.toUpperCase() : '';
  if (!/^[A-Z0-9]{3,12}$/.test(code)) return send(ws, { type: 'error', message: 'Неверный код комнаты' });
  const cid = typeof m.cid === 'string' && /^[A-Za-z0-9]{8,32}$/.test(m.cid) ? m.cid : crypto.randomBytes(6).toString('hex');
  let r = rooms.get(code);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: 'Сервер сейчас занят, попробуйте позже' });
    r = createRoom(code);
  }
  const old = r.clients.get(cid);
  if (!old && r.clients.size >= MAX_PER_ROOM) return send(ws, { type: 'error', message: 'В комнате нет мест' });

  clearTimeout(r.timer);
  r.timer = null;
  ws.id = cid;
  ws.name = (typeof m.name === 'string' && clean(m.name, 24)) || 'Гость';
  ws.avatar = parseAvatar(m.avatar);
  ws.avRef = avatarRef(ws.avatar);
  const wasAway = r.left.has(cid);
  if (wasAway) { clearTimeout(r.left.get(cid)); r.left.delete(cid); }
  if (old) { // то же устройство подключилось заново: старый сокет заменяем тихо
    old.room = null;
    r.clients.delete(cid);
    try { old.close(4001, 'replaced'); } catch {}
  }
  ws.room = r;
  r.clients.set(cid, ws);

  // Первый вошедший в «пустую» комнату после перезапуска сервера возвращает источник и позицию
  const res = m.resume;
  if (!r.source && res && typeof res === 'object') {
    const src = validSource(res.source);
    const t = typeof res.time === 'number' ? res.time : NaN;
    if (src) {
      r.source = src;
      r.time = isFinite(t) && t >= 0 && t <= MAX_TIME ? t : 0;
      r.playing = false;
      r.at = Date.now();
      pushRecent(r, src);
    }
  }

  send(ws, {
    type: 'init', you: cid, epoch: EPOCH, eid: r.lastEid,
    users: userList(r), source: r.source, recent: r.recent,
    state: { playing: r.playing, time: pos(r) }, history: r.history,
  });
  broadcast(r, { type: 'users', users: userList(r) }, ws);
  if (!old && !wasAway) broadcast(r, { type: 'sys', text: `${ws.name} зашёл(а)` }, ws);
}

function handle(ws, m) {
  if (m.type === 'ping') {
    if (take(ws.pingB)) send(ws, { type: 'pong', t: typeof m.t === 'number' ? m.t : 0 });
    return;
  }
  if (m.type === 'join') return join(ws, m);
  const r = ws.room;
  if (!r) return;

  switch (m.type) {
    case 'control': {
      if (!take(ws.ctlB)) return;
      const t = m.time;
      if (!['play', 'pause', 'seek'].includes(m.action) || typeof t !== 'number' || !isFinite(t) || t < 0 || t > MAX_TIME) return;
      r.time = t;
      if (m.action === 'play') r.playing = true;
      if (m.action === 'pause') r.playing = false;
      r.at = Date.now();
      broadcast(r, { type: 'state', playing: r.playing, time: r.time, by: ws.name, action: m.action }, ws);
      break;
    }
    case 'needState':
      send(ws, { type: 'state', playing: r.playing, time: pos(r) });
      break;
    case 'setSource': {
      const src = validSource(m.source);
      if (!src) return send(ws, { type: 'error', message: 'Этот источник не поддерживается' });
      if (!take(ws.srcB)) return send(ws, { type: 'error', message: 'Слишком часто меняете видео' });
      r.source = src;
      r.playing = false;
      r.time = 0;
      r.at = Date.now();
      pushRecent(r, src);
      broadcast(r, { type: 'source', source: src, by: ws.name, byId: ws.id, recent: r.recent });
      break;
    }
    case 'chat': {
      if (typeof m.text !== 'string') return;
      const fly = m.mode === 'fly';
      const text = clean(m.text, fly ? 100 : 400);
      if (!text || !take(ws.chatB)) return;
      const color = Number.isInteger(m.color) && m.color >= 0 && m.color < 8 ? m.color : 0;
      const entry = { id: ws.id, name: ws.name, text, color, av: presetOnly(ws.avRef), t: Date.now(), eid: nextEid(r) };
      if (fly) entry.mode = 'fly';
      else {
        r.history.push(entry); // летающие комментарии в историю чата не попадают
        if (r.history.length > 50) r.history.shift();
      }
      broadcast(r, { type: 'chat', ...entry });
      break;
    }
    case 'reaction': {
      if (typeof m.emoji !== 'string' || !EMOJI.has(m.emoji) || !take(ws.reactB)) return;
      // Сервер решает, нужен ли звук: по привязке из манифеста и с ограничениями на частоту.
      // Эмодзи при этом показывается всегда. Клиентам уходит только id звука, не сам файл.
      let sound = null;
      const sid = sounds.soundFor(m.emoji);
      const now = Date.now();
      if (sid && now - ws.lastSound >= SOUND_GAP_MS && roomSoundOk(r, now)) { sound = sid; ws.lastSound = now; }
      broadcast(r, { type: 'reaction', emoji: m.emoji, name: ws.name, id: ws.id, sound, eid: nextEid(r) });
      break;
    }
    case 'countdown': {
      const now = Date.now();
      if (now - r.lastCountdown < 4000) return;
      r.lastCountdown = now;
      broadcast(r, { type: 'countdown', by: ws.name, eid: nextEid(r) });
      break;
    }
    case 'profile': {
      const hasName = typeof m.name === 'string';
      if (!hasName && m.avatar === undefined) return;
      const now = Date.now();
      if (now - ws.lastProfile < 2000) return send(ws, { type: 'error', message: 'Профиль можно менять не чаще раза в 2 секунды' });
      ws.lastProfile = now;
      let changed = false;
      if (hasName) {
        const name = clean(m.name, 24);
        if (name && name !== ws.name) { ws.name = name; changed = true; }
      }
      if (m.avatar !== undefined) {
        const av = parseAvatar(m.avatar);
        if (!av) return send(ws, { type: 'error', message: 'Аватарка не подходит: нужен PNG, JPEG или WebP до 32 КБ' });
        ws.avatar = av;
        ws.avRef = avatarRef(av);
        changed = true;
      }
      if (changed) broadcast(r, { type: 'users', users: userList(r) });
      break;
    }
  }
}

/* ---------- HTTP ---------- */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com https://player.vimeo.com https://cdn.jsdelivr.net https://vk.ru https://vk.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  'media-src * blob: data:',
  'connect-src * ws: wss:',   // прямые ссылки на видео и HLS могут лежать на любом хосте
  'frame-src https:',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function text(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function onRequest(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return text(res, 400, 'Bad request'); }
  const p = url.pathname;

  if (p === '/healthz') return text(res, 200, 'ok');
  if (p === '/api/sounds') {
    const body = JSON.stringify(sounds.get());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const am = /^\/a\/([A-Z0-9]{3,12})\/([A-Za-z0-9]{8,32})$/.exec(p);
  if (am) {
    const r = rooms.get(am[1]);
    const c = r && r.clients.get(am[2]);
    const av = c && c.avatar;
    if (!av) return text(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': av.mime,
      'Content-Length': av.buf.length,
      // адрес с хэшем содержимого можно кэшировать надолго, без него — каждый раз проверять
      'Cache-Control': url.searchParams.get('h') === av.hash ? 'public, max-age=86400, immutable' : 'no-cache',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    return res.end(req.method === 'HEAD' ? undefined : av.buf);
  }
  if (p.startsWith('/api/')) return text(res, 404, 'Not found');
  serveStatic(req, res, p, () => text(res, 404, 'Not found'));
}

/* ---------- WebSocket ---------- */
const server = http.createServer(onRequest);

const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024, // аватарка до 32 КБ в base64 + служебные поля
  verifyClient(info, done) {
    if (wss.clients.size >= MAX_CONNECTIONS) return done(false, 503, 'busy');
    // Чужие сайты не должны подключаться к комнатам из браузера пользователя
    const origin = info.origin, host = info.req.headers.host;
    if (origin && host && process.env.ALLOW_ANY_ORIGIN !== '1') {
      let oh = '';
      try { oh = new URL(origin).host; } catch {}
      if (oh !== host) return done(false, 403, 'forbidden origin');
    }
    done(true);
  },
});

wss.on('connection', (ws) => {
  ws.id = '';
  ws.room = null;
  ws.name = '';
  ws.avatar = null;
  ws.avRef = null;
  ws.alive = true;
  ws.lastSound = 0;
  ws.lastProfile = 0;
  ws.allB = bucket(40, 20);   // общий предохранитель от потока сообщений
  ws.chatB = bucket(6, 1.5);
  ws.reactB = bucket(5, 2.5); // клиент считает так же и не показывает то, что сервер отбросит
  ws.ctlB = bucket(10, 6);
  ws.srcB = bucket(1, 1);
  ws.pingB = bucket(10, 1);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw, isBinary) => {
    if (isBinary || !take(ws.allB)) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error('handler error:', e); }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Служебный пинг: убирает «мёртвые» соединения (закрытый ноутбук, пропавшая сеть), чтобы они не копились
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
heartbeat.unref();

// Раз в 8 секунд играющим комнатам отправляется «эталонная» позиция; на паузе — раз в ~30 секунд.
let tick = 0;
const syncTimer = setInterval(() => {
  tick++;
  for (const r of rooms.values()) {
    if (!r.clients.size || !(r.playing || tick % 4 === 0)) continue;
    broadcast(r, { type: 'sync', playing: r.playing, time: pos(r) });
  }
}, 8000);
syncTimer.unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Киноклуб запущен: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
  // Render присылает SIGTERM при деплое: аккуратно закрываем сокеты, клиенты переподключатся сами
  const stop = () => {
    for (const c of wss.clients) { try { c.close(1012, 'restart'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server, wss, rooms };
