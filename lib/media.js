'use strict';
// Валидация источников видео и аватарок, список эмодзи и манифест звуков.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AVATAR_PRESETS = 12;      // должно совпадать с KC.AVATAR_PRESETS на клиенте
const AVATAR_MAX = 32 * 1024;   // максимум байт после декодирования

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, n);

/* ---------- эмодзи ---------- */
function loadEmoji(publicDir) {
  const set = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(publicDir, 'emoji.json'), 'utf8'));
    for (const c of data.categories) for (const it of c.items) set.add(it[0]);
  } catch (e) {
    console.error('Не удалось прочитать emoji.json:', e.message);
  }
  return set;
}

/* ---------- звуки ---------- */
// public/sounds/manifest.json: { sounds: {id: {file, title, volume}}, bindings: {эмодзи: id} }
// Звук считается доступным, только если файл реально лежит в public/sounds/.
function createSounds(publicDir) {
  const dir = path.join(publicDir, 'sounds');
  let cached = null, at = 0;

  function load() {
    const out = { sounds: {}, bindings: {} };
    let man;
    try { man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return out; }
    const sounds = man && typeof man.sounds === 'object' && man.sounds ? man.sounds : {};
    for (const [id, def] of Object.entries(sounds)) {
      if (!/^[a-z0-9_-]{1,40}$/i.test(id) || !def || typeof def.file !== 'string') continue;
      if (!/^[\w.\- ]{1,80}\.(mp3|ogg|wav|m4a|webm)$/i.test(def.file)) continue;
      let ok = false;
      try { ok = fs.statSync(path.join(dir, def.file)).isFile(); } catch {}
      if (!ok) continue;
      const vol = Number(def.volume);
      out.sounds[id] = {
        url: '/sounds/' + encodeURIComponent(def.file),
        title: clean(def.title || id, 40),
        volume: isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1,
      };
    }
    const b = man && typeof man.bindings === 'object' && man.bindings ? man.bindings : {};
    for (const [emoji, id] of Object.entries(b)) if (out.sounds[id]) out.bindings[emoji] = id;
    return out;
  }
  function get() {
    const now = Date.now();
    if (!cached || now - at > 15000) { cached = load(); at = now; }
    return cached;
  }
  return { get, soundFor: (emoji) => get().bindings[emoji] || null };
}

/* ---------- источники видео ---------- */
function validSource(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'yt' && /^[\w-]{11}$/.test(s.id)) return { type: 'yt', id: s.id };
  if (s.type === 'vimeo' && /^\d{1,12}$/.test(String(s.id))) {
    const o = { type: 'vimeo', id: String(s.id) };
    if (typeof s.h === 'string' && /^[a-f0-9]{6,20}$/i.test(s.h)) o.h = s.h;
    return o;
  }
  if (s.type === 'rutube' && typeof s.id === 'string' && /^[a-f0-9]{32}$/i.test(s.id)) {
    const o = { type: 'rutube', id: s.id.toLowerCase() };
    if (typeof s.p === 'string' && /^[\w-]{6,64}$/.test(s.p)) o.p = s.p; // ключ приватного видео
    return o;
  }
  if (s.type === 'vk' && typeof s.oid === 'string' && /^-?\d{1,12}$/.test(s.oid) && typeof s.id === 'string' && /^\d{1,12}$/.test(s.id)) {
    const o = { type: 'vk', oid: s.oid, id: s.id };
    if (typeof s.h === 'string' && /^[a-f0-9]{6,32}$/i.test(s.h)) o.h = s.h;
    return o;
  }
  if (s.type === 'url' && typeof s.url === 'string' && s.url.length <= 2000 && /^https?:\/\//i.test(s.url)) {
    try { new URL(s.url); } catch { return null; }
    return { type: 'url', url: s.url };
  }
  if (s.type === 'file') {
    const name = clean(s.name, 200);
    const size = Number(s.size);
    if (name && isFinite(size) && size >= 0) return { type: 'file', name, size };
  }
  return null;
}

const sameSource = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- аватарки ---------- */
function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
// { p: номер } -> стандартная; { data: base64 } -> загруженная (тип определяется по содержимому)
function parseAvatar(a) {
  if (!a || typeof a !== 'object') return null;
  if (Number.isInteger(a.p) && a.p >= 0 && a.p < AVATAR_PRESETS) return { preset: a.p };
  if (typeof a.data === 'string' && a.data.length <= Math.ceil(AVATAR_MAX * 4 / 3) + 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(a.data)) {
    const buf = Buffer.from(a.data, 'base64');
    if (buf.length < 32 || buf.length > AVATAR_MAX) return null;
    const mime = sniff(buf);
    if (!mime) return null;
    return { mime, buf, hash: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10) };
  }
  return null;
}
const avatarRef = (av) => (!av ? null : av.preset != null ? 'p' + av.preset : 'h' + av.hash);

module.exports = { clean, loadEmoji, createSounds, validSource, sameSource, parseAvatar, avatarRef, AVATAR_PRESETS };
