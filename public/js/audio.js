'use strict';
// Звуки эмодзи: сервер присылает только id звука, файлы грузятся и декодируются заранее.
(function () {
  const KC = window.KC;
  const AC = window.AudioContext || window.webkitAudioContext;
  const MAX_VOICES = 6;
  const SAME_SOUND_GAP = 120; // мс: один и тот же звук не чаще

  const A = (KC.audio = {
    ctx: null, master: null, defs: {}, bindings: {}, buffers: new Map(),
    voices: 0, last: new Map(), listeners: [], loading: false,
  });

  A.onChange = (fn) => A.listeners.push(fn);
  const fire = () => A.listeners.forEach((fn) => fn());
  A.available = () => Object.keys(A.defs).length > 0;
  A.running = () => !!A.ctx && A.ctx.state === 'running';
  A.hasSound = (emoji) => !!A.bindings[emoji] && A.buffers.has(A.bindings[emoji]);

  function ensureCtx() {
    if (A.ctx || !AC) return A.ctx;
    try {
      A.ctx = new AC({ latencyHint: 'interactive' });
      A.master = A.ctx.createGain();
      A.master.gain.value = KC.settings.volume;
      A.master.connect(A.ctx.destination);
      A.ctx.onstatechange = fire;
    } catch { A.ctx = null; }
    return A.ctx;
  }

  // Браузеры не дают играть звук без жеста пользователя. Любое первое нажатие «разблокирует» его.
  A.unlock = () => {
    const c = ensureCtx();
    if (c && c.state !== 'running') c.resume().then(fire, () => {});
  };
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) =>
    window.addEventListener(ev, A.unlock, { capture: true, passive: true }));

  A.load = async () => {
    if (A.loading) return;
    A.loading = true;
    try {
      const res = await fetch('/api/sounds', { cache: 'no-cache' });
      const man = await res.json();
      A.defs = man.sounds || {};
      A.bindings = man.bindings || {};
    } catch { A.loading = false; return; }
    const c = ensureCtx();
    fire();
    if (!c) return;
    await Promise.all(Object.entries(A.defs).map(async ([id, def]) => {
      try {
        const r = await fetch(def.url);
        if (!r.ok) throw new Error(r.status);
        const ab = await r.arrayBuffer();
        // callback-форма нужна старым Safari
        const buf = await new Promise((ok, bad) => c.decodeAudioData(ab, ok, bad));
        A.buffers.set(id, buf);
      } catch { /* битый или отсутствующий файл: звук просто недоступен */ }
    }));
    A.loading = false;
    fire();
  };

  // Короткая рампа вместо резкого скачка (нет щелчков). Прежнее расписание сбрасываем:
  // цепочка setTargetAtTime в Chrome со временем переставала применять новые значения.
  A.setVolume = (v) => {
    if (!A.master) return;
    const g = A.master.gain, t = A.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(v, t + 0.04);
  };

  // true, если звук действительно запущен
  A.play = (id) => {
    if (!KC.settings.sound || !A.ctx || A.ctx.state !== 'running') return false;
    const buf = A.buffers.get(id);
    if (!buf || A.voices >= MAX_VOICES) return false;
    const now = performance.now();
    if (now - (A.last.get(id) || 0) < SAME_SOUND_GAP) return false;
    A.last.set(id, now);
    const src = A.ctx.createBufferSource();
    src.buffer = buf;
    const g = A.ctx.createGain();
    g.gain.value = (A.defs[id] && A.defs[id].volume) ?? 1;
    src.connect(g).connect(A.master);
    A.voices++;
    src.onended = () => { A.voices--; src.disconnect(); g.disconnect(); };
    src.start();
    return true;
  };

  // Кнопка «проверить звук» в настройках: берём первый реально загруженный звук пользователя
  A.test = () => {
    const id = [...A.buffers.keys()][0];
    return id ? A.play(id) : false;
  };

  KC.onSetting((k, v) => { if (k === 'volume') A.setVolume(v); if (k === 'sound') fire(); });
})();
