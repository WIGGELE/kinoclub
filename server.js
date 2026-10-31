'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');
const MAX_PER_ROOM = 20;
const EMOJI = ['❤️', '😂', '😮', '👏', '🔥', '😢'];

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200);
    return res.end('ok');
  }
  fs.readFile(INDEX, (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end('Server error');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const rooms = new Map();

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { code, source: null, playing: false, time: 0, rate: 1, at: Date.now(), clients: new Set(), history: [], timer: null };
    rooms.set(code, r);
  }
  clearTimeout(r.timer);
  r.timer = null;
  return r;
}

const pos = (r) => (r.playing ? r.time + ((Date.now() - r.at) / 1000) * r.rate : r.time);
const stateOf = (r) => ({ playing: r.playing, time: pos(r), rate: r.rate });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const broadcast = (r, o, except) => {
  const s = JSON.stringify(o);
  for (const c of r.clients) if (c !== except && c.readyState === 1) c.send(s);
};
const userList = (r) => [...r.clients].map((c) => ({ id: c.id, name: c.name }));
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

function allow(ws) {
  const now = Date.now();
  ws.bucket = Math.min(8, ws.bucket + ((now - ws.lastRefill) / 1000) * 1.5);
  ws.lastRefill = now;
  if (ws.bucket < 1) return false;
  ws.bucket -= 1;
  return true;
}

function validSource(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'yt' && /^[\w-]{11}$/.test(s.id)) return { type: 'yt', id: s.id };
  if (s.type === 'url' && typeof s.url === 'string' && s.url.length <= 2000 && /^https?:\/\//i.test(s.url)) {
    return { type: 'url', url: s.url };
  }
  if (s.type === 'file') {
    const name = clean(s.name, 200);
    const size = Number(s.size);
    if (name && isFinite(size) && size >= 0) return { type: 'file', name, size };
  }
  return null;
}

function leave(ws) {
  const r = ws.room;
  if (!r) return;
  ws.room = null;
  r.clients.delete(ws);
  if (r.clients.size === 0) {
    r.timer = setTimeout(() => rooms.delete(r.code), 10 * 60 * 1000);
    return;
  }
  broadcast(r, { type: 'users', users: userList(r) });
  broadcast(r, { type: 'sys', text: `${ws.name} вышел(а)` });
}

function handle(ws, m) {
  if (m.type === 'join') {
    if (ws.room) return;
    const code = String(m.room || '').toUpperCase();
    if (!/^[A-Z0-9]{3,12}$/.test(code)) return send(ws, { type: 'error', message: 'Неверный код комнаты' });
    const r = getRoom(code);
    if (r.clients.size >= MAX_PER_ROOM) return send(ws, { type: 'error', message: 'В комнате нет мест' });
    ws.name = clean(m.name, 24) || 'Гость';
    ws.room = r;
    r.clients.add(ws);
    send(ws, {
      type: 'init',
      you: ws.id,
      users: userList(r),
      source: r.source,
      state: stateOf(r),
      history: r.history,
    });
    broadcast(r, { type: 'users', users: userList(r) }, ws);
    broadcast(r, { type: 'sys', text: `${ws.name} зашёл(а)` }, ws);
    return;
  }

  const r = ws.room;
  if (!r) return;

  switch (m.type) {
    case 'control': {
      const t = Number(m.time);
      if (!['play', 'pause', 'seek', 'rate'].includes(m.action) || !isFinite(t) || t < 0) return;
      if (m.action === 'rate') {
        // Смена скорости не двигает позицию: время комнаты пересчитывается по старой скорости,
        // дальше считается по новой. Позицию, которую прислал клиент, игнорируем:
        // из-за буферизации она может отставать, и тогда все откатились бы назад.
        const rate = Number(m.rate);
        if (!isFinite(rate) || rate < 0.25 || rate > 4) return;
        r.time = pos(r);
        r.rate = rate;
      } else {
        r.time = t;
        if (m.action === 'play') r.playing = true;
        if (m.action === 'pause') r.playing = false;
      }
      r.at = Date.now();
      broadcast(r, { type: 'state', ...stateOf(r), by: ws.name, action: m.action }, ws);
      break;
    }
    case 'needState':
      send(ws, { type: 'state', ...stateOf(r) });
      break;
    case 'setSource': {
      const src = validSource(m.source);
      if (!src) return;
      r.source = src;
      r.playing = false;
      r.time = 0;
      r.rate = 1;
      r.at = Date.now();
      broadcast(r, { type: 'source', source: src, by: ws.name });
      break;
    }
    case 'chat': {
      const text = clean(m.text, 400);
      if (!text || !allow(ws)) return;
      const entry = { id: ws.id, name: ws.name, text, t: Date.now() };
      r.history.push(entry);
      if (r.history.length > 50) r.history.shift();
      broadcast(r, { type: 'chat', ...entry });
      break;
    }
    case 'reaction':
      if (!EMOJI.includes(m.emoji) || !allow(ws)) return;
      broadcast(r, { type: 'reaction', emoji: m.emoji, name: ws.name });
      break;
  }
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(4).toString('hex');
  ws.room = null;
  ws.name = '';
  ws.bucket = 5;
  ws.lastRefill = Date.now();
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    handle(ws, m);
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Раз в 8 секунд всем отправляется «эталонная» позиция, клиенты подтягиваются к ней.
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.clients.size) broadcast(r, { type: 'sync', ...stateOf(r) });
  }
}, 8000);

server.listen(PORT, () => console.log(`Киноклуб запущен: http://localhost:${PORT}`));
