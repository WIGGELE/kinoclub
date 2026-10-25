'use strict';
// Общие утилиты, настройки и аватарки. Все модули делят пространство имён KC.
(function () {
  const KC = (window.KC = {});
  KC.$ = (s, root = document) => root.querySelector(s);
  KC.$$ = (s, root = document) => [...root.querySelectorAll(s)];

  KC.AVATAR_PRESETS = 12; // должно совпадать с lib/media.js
  KC.QUICK = ['❤️', '😂', '😮', '👏', '🔥', '😢'];
  KC.DM_COLORS = ['#ffffff', '#ffb347', '#ff6b81', '#7bed9f', '#70a1ff', '#eccc68', '#a29bfe', '#ff9ff3'];
  const PRESETS = [
    ['🐱', '#ffb347'], ['🦊', '#ff7a59'], ['🐼', '#cfd8dc'], ['🐸', '#7bed9f'], ['🦄', '#ff9ff3'], ['🐙', '#a29bfe'],
    ['🐧', '#70a1ff'], ['🦉', '#c8a26b'], ['🐯', '#ffd166'], ['🐨', '#9fb3c8'], ['🦖', '#6ee7b7'], ['🤖', '#94a3b8'],
  ];

  /* ---------- хранилище (может быть недоступно) ---------- */
  KC.store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  /* ---------- настройки ---------- */
  const DEF = { sound: true, volume: 0.7, danmaku: true, dmSpeed: 1, dmSize: 22, dmOpacity: 0.9, dmDensity: 0.6, dmChat: true, reactions: true };
  const RANGE = { volume: [0, 1], dmSpeed: [0.5, 2], dmSize: [14, 40], dmOpacity: [0.2, 1], dmDensity: [0.2, 1] };
  KC.settings = { ...DEF };
  const saved = KC.store.get('kc_settings', {});
  for (const k of Object.keys(DEF)) {
    if (!(k in saved) || typeof saved[k] !== typeof DEF[k]) continue;
    KC.settings[k] = RANGE[k] ? Math.min(RANGE[k][1], Math.max(RANGE[k][0], saved[k])) : saved[k];
  }
  const listeners = [];
  KC.onSetting = (fn) => listeners.push(fn);
  KC.setSetting = (k, v) => {
    if (!(k in DEF)) return;
    if (RANGE[k]) v = Math.min(RANGE[k][1], Math.max(RANGE[k][0], Number(v)));
    KC.settings[k] = v;
    KC.store.set('kc_settings', KC.settings);
    listeners.forEach((fn) => fn(k, v));
  };

  /* ---------- мелочи ---------- */
  let toastTimer;
  KC.toast = (text) => {
    const t = KC.$('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  };
  KC.colorFor = (name) => {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 70% 70%)`;
  };
  KC.randomId = (n = 12) => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return [...a].map((b) => (b % 36).toString(36)).join('');
  };
  KC.hashStr = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

  /* ---------- аватарки ---------- */
  // user: { name, av: 'p3' | 'h<hash>' | null, id }, opts: { room, src }
  KC.avatarEl = (user, opts = {}) => {
    const d = document.createElement('div');
    d.className = 'ava';
    const name = user.name || '?';
    const letter = () => {
      d.textContent = name.trim().charAt(0).toUpperCase() || '?';
      d.style.background = KC.colorFor(name);
    };
    const ref = user.av;
    if (opts.src || (ref && ref[0] === 'h' && opts.room && user.id)) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      img.src = opts.src || `/a/${opts.room}/${user.id}?h=${encodeURIComponent(ref.slice(1))}`;
      img.onerror = () => { img.remove(); letter(); };
      d.appendChild(img);
    } else if (ref && ref[0] === 'p' && PRESETS[Number(ref.slice(1))]) {
      const [emoji, color] = PRESETS[Number(ref.slice(1))];
      d.textContent = emoji;
      d.style.background = color;
    } else letter();
    return d;
  };
  KC.presetAvatar = (n) => ({ emoji: PRESETS[n][0], color: PRESETS[n][1] });
})();
