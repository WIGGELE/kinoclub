'use strict';
// Летающие комментарии. Анимация идёт через Web Animations (transform на композиторе),
// дорожки выбираются так, чтобы комментарии не наезжали друг на друга.
(function () {
  const KC = window.KC;
  const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  const CROSS_SEC = 9;        // за сколько секунд комментарий пересекает экран при скорости ×1
  const MAX_QUEUE = 40;
  const STALE_MS = 6000;      // ожидающие дольше — выбрасываем
  const FORCE_MINE_MS = 1500; // свои комментарии не ждут дольше этого

  const D = (KC.danmaku = {});
  let layer = null, W = 0, H = 0;
  let laneFree = [], laneEnd = [];
  let queue = [], active = 0, timer = null, ro = null;
  const ctx = document.createElement('canvas').getContext('2d');

  function geometry() {
    const size = KC.settings.dmSize;
    const laneH = Math.round(size * 1.35);
    const usable = H * 0.82; // низ оставляем свободным: там полоса управления плеера
    const total = Math.max(1, Math.floor(usable / laneH));
    const allowed = Math.max(1, Math.ceil(total * KC.settings.dmDensity));
    return { size, laneH, allowed };
  }
  const maxActive = () => Math.round(15 + 60 * KC.settings.dmDensity);

  function measure() {
    W = layer.clientWidth;
    H = layer.clientHeight;
    laneFree = [];
    laneEnd = [];
  }

  D.init = (el) => {
    layer = el;
    measure();
    if (window.ResizeObserver) {
      ro = new ResizeObserver(measure);
      ro.observe(layer);
    }
    KC.onSetting((k) => {
      if (k === 'dmOpacity') layer.style.opacity = KC.settings.dmOpacity;
      if (k === 'danmaku') { layer.hidden = !KC.settings.danmaku; if (!KC.settings.danmaku) D.clear(); }
    });
    layer.style.opacity = KC.settings.dmOpacity;
    layer.hidden = !KC.settings.danmaku;
  };

  D.clear = () => {
    queue = [];
    clearTimeout(timer);
    timer = null;
    if (layer) for (const a of layer.getAnimations({ subtree: true })) a.cancel();
    if (layer) layer.textContent = '';
    active = 0;
    laneFree = [];
    laneEnd = [];
  };

  D.add = (text, opts = {}) => {
    if (!layer || !KC.settings.danmaku || document.hidden) return;
    const item = { text, color: opts.color || '#fff', mine: !!opts.mine, t0: performance.now() };
    if (item.mine) queue.unshift(item); else queue.push(item);
    while (queue.length > MAX_QUEUE) {
      const i = queue.findIndex((q) => !q.mine);
      queue.splice(i < 0 ? queue.length - 1 : i, 1);
    }
    pump();
  };

  function place(item, now) {
    if (!W) measure();
    if (!W) return false;
    const { size, laneH, allowed } = geometry();
    ctx.font = `600 ${size}px ${FONT}`;
    const w = Math.ceil(ctx.measureText(item.text).width) + (item.mine ? 14 : 4);
    const v = (W * KC.settings.dmSpeed) / CROSS_SEC;            // px/с, одинаково для всех
    const dur = ((W + w) / v) * 1000;
    let lane = -1;
    for (let i = 0; i < allowed; i++) {
      // дорожка свободна, когда хвост предыдущего уже вошёл на экран и мы его не догоним
      if ((laneFree[i] || 0) <= now && now + dur >= (laneEnd[i] || 0)) { lane = i; break; }
    }
    if (lane < 0) {
      if (!(item.mine && now - item.t0 > FORCE_MINE_MS)) return false;
      lane = 0;
      for (let i = 1; i < allowed; i++) if ((laneFree[i] || 0) < (laneFree[lane] || 0)) lane = i;
    }
    laneFree[lane] = now + ((w + size * 1.5) / v) * 1000;
    laneEnd[lane] = now + dur;

    const el = document.createElement('div');
    el.className = item.mine ? 'dm mine' : 'dm';
    el.textContent = item.text;
    el.style.cssText = `font-size:${size}px;color:${item.color};top:${lane * laneH}px`;
    layer.appendChild(el);
    active++;
    const anim = el.animate(
      [{ transform: `translate3d(${W}px,0,0)` }, { transform: `translate3d(${-w}px,0,0)` }],
      { duration: dur, easing: 'linear', fill: 'forwards' });
    anim.onfinish = anim.oncancel = () => { if (el.isConnected) { el.remove(); active--; } };
    return true;
  }

  function pump() {
    timer = null;
    const now = performance.now();
    queue = queue.filter((q) => q.mine || now - q.t0 < STALE_MS);
    while (queue.length && active < maxActive()) {
      if (!place(queue[0], now)) break;
      queue.shift();
    }
    if (queue.length) timer = setTimeout(pump, 80);
  }

  // Размер и скорость действуют на новые комментарии; смена размера не должна ломать дорожки
  KC.onSetting((k) => { if (k === 'dmSize' || k === 'dmSpeed' || k === 'dmDensity') { laneFree = []; laneEnd = []; } });
  D.stats = () => ({ active, queued: queue.length });
})();
