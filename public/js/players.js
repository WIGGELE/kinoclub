'use strict';
// Адаптеры плееров. Общий интерфейс:
//   { caps:{control}, time(), playing(), play(), pause(), seek(t), nudge?(drift), destroy() }
// hooks: { host, emit(action,t), suppressed(), toast(text), onReady(p), manual(on, why) }
(function () {
  const KC = window.KC;
  const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
  const VIMEO_API = 'https://player.vimeo.com/api/player.js';
  const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-forms allow-popups allow-popups-to-escape-sandbox';
  const loaded = new Map();

  KC.loadScript = (src) => {
    if (loaded.has(src)) return loaded.get(src);
    const p = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = res;
      s.onerror = () => { loaded.delete(src); rej(new Error('script ' + src)); };
      document.head.appendChild(s);
    });
    loaded.set(src, p);
    return p;
  };

  // sandbox и allow нужно задавать ДО вставки в страницу: после начала загрузки они уже не действуют
  const makeFrame = (host, src, allow, sandbox) => {
    const f = document.createElement('iframe');
    if (sandbox) f.setAttribute('sandbox', sandbox);
    f.allow = allow;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.title = 'Видео';
    f.src = src;
    host.appendChild(f);
    return f;
  };

  /* ---------- обычное видео, файл и HLS ---------- */
  function makeVideo(url, h) {
    const v = document.createElement('video');
    v.controls = true;
    v.playsInline = true;
    v.preload = 'auto';
    // полноэкранный режим даёт наша кнопка: так поверх видео остаются комментарии и реакции
    v.setAttribute('controlslist', 'nofullscreen');
    h.host.appendChild(v);
    let hls = null, dead = false, rateTimer = null;
    const isHls = /\.m3u8(\?|#|$)/i.test(url);
    if (!isHls || v.canPlayType('application/vnd.apple.mpegurl')) v.src = url;
    else {
      KC.loadScript(HLS_URL).then(() => {
        if (dead) return;
        if (!window.Hls || !Hls.isSupported()) return h.toast('Этот браузер не умеет играть HLS (.m3u8)');
        hls = new Hls({ maxBufferLength: 30 });
        hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) h.toast('Не удалось загрузить поток .m3u8 (возможно, сайт запрещает доступ из браузера)'); });
        hls.loadSource(url);
        hls.attachMedia(v);
      }).catch(() => h.toast('Не удалось загрузить библиотеку HLS'));
    }
    const p = {
      caps: { control: true },
      time: () => v.currentTime,
      playing: () => !v.paused && !v.ended,
      play: () => { const r = v.play(); if (r && r.catch) r.catch(() => h.toast('Браузер заблокировал автозапуск. Нажмите ▶ в плеере')); },
      pause: () => v.pause(),
      seek: (t) => { v.currentTime = t; },
      // Небольшой дрейф исправляем не рывком, а слегка меняя скорость
      nudge(drift) {
        clearTimeout(rateTimer);
        if (!drift) { v.playbackRate = 1; return; }
        v.playbackRate = drift > 0 ? 0.95 : 1.05;
        rateTimer = setTimeout(() => { v.playbackRate = 1; }, Math.min(8000, (Math.abs(drift) / 0.05) * 1000));
      },
      destroy() {
        dead = true;
        clearTimeout(rateTimer);
        if (hls) hls.destroy();
        v.pause(); v.removeAttribute('src'); v.load(); v.remove();
      },
    };
    v.addEventListener('loadedmetadata', () => h.onReady(p), { once: true });
    v.addEventListener('play', () => h.emit('play', v.currentTime));
    v.addEventListener('pause', () => { if (!v.ended) h.emit('pause', v.currentTime); });
    v.addEventListener('seeked', () => h.emit('seek', v.currentTime));
    v.addEventListener('error', () => { if (v.getAttribute('src')) h.toast('Не удалось загрузить видео. Проверьте ссылку или формат файла'); });
    return p;
  }

  /* ---------- YouTube ---------- */
  let ytLoading = null;
  function loadYT() {
    if (ytLoading) return ytLoading;
    ytLoading = new Promise((res, rej) => {
      if (window.YT && YT.Player) return res();
      window.onYouTubeIframeAPIReady = res;
      KC.loadScript('https://www.youtube.com/iframe_api').catch(rej);
    });
    ytLoading.catch(() => { ytLoading = null; });
    return ytLoading;
  }
  function makeYT(id, h) {
    const box = document.createElement('div');
    box.id = 'yt' + Date.now();
    h.host.appendChild(box);
    let yt = null, ok = false, dead = false, poll = null, last = 0;
    const p = {
      caps: { control: true },
      time: () => (ok ? yt.getCurrentTime() : 0),
      playing: () => ok && yt.getPlayerState() === 1,
      play: () => ok && yt.playVideo(),
      pause: () => ok && yt.pauseVideo(),
      seek: (t) => ok && yt.seekTo(t, true),
      destroy() { dead = true; clearInterval(poll); try { yt && yt.destroy(); } catch {} box.remove(); },
    };
    // YouTube не сообщает о перемотке событием, поэтому раз в 500 мс ищем «скачок» времени
    function tick() {
      if (document.hidden) return;
      const t = yt.getCurrentTime();
      const expected = last + (yt.getPlayerState() === 1 ? 0.5 : 0);
      if (Math.abs(t - expected) > 1.5 && !h.suppressed()) h.emit('seek', t);
      last = t;
    }
    loadYT().then(() => {
      if (dead) return;
      yt = new YT.Player(box.id, {
        videoId: id, width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, fs: 0, origin: location.origin },
        events: {
          onReady() { ok = true; last = yt.getCurrentTime(); poll = setInterval(tick, 500); h.onReady(p); },
          onStateChange(e) {
            if (h.suppressed()) return;
            if (e.data === 1) h.emit('play', yt.getCurrentTime());
            else if (e.data === 2) h.emit('pause', yt.getCurrentTime());
          },
          onError() { h.toast('YouTube не смог открыть это видео (возможно, встраивание запрещено)'); },
        },
      });
    }).catch(() => h.toast('Не удалось загрузить плеер YouTube'));
    return p;
  }

  /* ---------- Vimeo (официальный Player SDK) ---------- */
  function makeVimeo(src, h) {
    const q = src.h ? `?h=${src.h}&dnt=1` : '?dnt=1';
    const frame = makeFrame(h.host, `https://player.vimeo.com/video/${src.id}${q}`, 'autoplay; picture-in-picture');
    let vp = null, dead = false, playing = false, t = 0, tAt = 0;
    const cur = () => (playing ? t + (performance.now() - tAt) / 1000 : t);
    const set = (sec, pl) => { t = sec; tAt = performance.now(); if (pl !== undefined) playing = pl; };
    const p = {
      caps: { control: true },
      time: cur,
      playing: () => playing,
      play: () => { vp && vp.play().catch(() => h.toast('Браузер заблокировал автозапуск. Нажмите ▶ в плеере')); },
      pause: () => { vp && vp.pause().catch(() => {}); },
      seek: (s) => { set(s); vp && vp.setCurrentTime(s).catch(() => {}); },
      destroy() { dead = true; try { vp && vp.destroy(); } catch {} frame.remove(); },
    };
    KC.loadScript(VIMEO_API).then(() => {
      if (dead) return;
      vp = new Vimeo.Player(frame);
      vp.ready().then(() => { if (!dead) h.onReady(p); }).catch(() => h.toast('Vimeo не смог открыть это видео'));
      vp.on('play', (e) => { set(e.seconds, true); h.emit('play', e.seconds); });
      vp.on('pause', (e) => { set(e.seconds, false); h.emit('pause', e.seconds); });
      vp.on('seeked', (e) => { set(e.seconds); h.emit('seek', e.seconds); });
      vp.on('timeupdate', (e) => set(e.seconds));
      vp.on('error', () => h.toast('Vimeo: видео недоступно для встраивания'));
    }).catch(() => h.toast('Не удалось загрузить плеер Vimeo'));
    return p;
  }

  /* ---------- RuTube (postMessage API) ---------- */
  // Работает как управляемый плеер, только если страница RuTube реально отвечает на команды.
  // Если за 10 секунд не пришло ни одного события, честно переключаемся на ручную синхронизацию.
  function makeRutube(id, h) {
    const frame = makeFrame(h.host, `https://rutube.ru/play/embed/${id}`, 'autoplay; encrypted-media; picture-in-picture');
    let playing = false, t = 0, tAt = performance.now(), heard = false, dead = false;
    const cur = () => (playing ? t + (performance.now() - tAt) / 1000 : t);
    const post = (type, data = {}) => { try { frame.contentWindow.postMessage(JSON.stringify({ type, data }), '*'); } catch {} };
    const p = {
      caps: { control: true },
      time: cur,
      playing: () => playing,
      play: () => post('player:play'),
      pause: () => post('player:pause'),
      seek: (s) => { t = s; tAt = performance.now(); post('player:setCurrentTime', { time: s }); },
      destroy() { dead = true; window.removeEventListener('message', onMsg); clearTimeout(watch); frame.remove(); },
    };
    function onMsg(e) {
      if (e.source !== frame.contentWindow) return;
      let m = e.data;
      if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
      if (!m || typeof m.type !== 'string' || !m.type.startsWith('player:')) return;
      if (!heard) { heard = true; clearTimeout(watch); h.onReady(p); }
      const d = m.data || {};
      if (m.type === 'player:currentTime' && isFinite(d.time)) {
        const jump = Math.abs(d.time - cur()) > 2;
        t = d.time; tAt = performance.now();
        if (jump && !h.suppressed()) h.emit('seek', t);
      } else if (m.type === 'player:changeState') {
        const now = d.state === 'playing';
        if (now !== playing) { playing = now; tAt = performance.now(); h.emit(now ? 'play' : 'pause', cur()); }
      }
    }
    window.addEventListener('message', onMsg);
    const watch = setTimeout(() => {
      if (dead || heard) return;
      p.caps.control = false;
      h.manual(true, 'rutube');
    }, 10000);
    return p;
  }

  /* ---------- встраиваемая страница (tapeop.dev и т. п.) ---------- */
  // Мы не знаем протокола управления чужим плеером и не изображаем его: только ручная синхронизация.
  function makeEmbed(url, h) {
    const frame = makeFrame(h.host, url, 'autoplay; encrypted-media; picture-in-picture; fullscreen', IFRAME_SANDBOX);
    h.manual(true, 'embed');
    return {
      caps: { control: false },
      time: () => 0, playing: () => false, play() {}, pause() {}, seek() {},
      destroy() { frame.remove(); },
    };
  }

  /* ---------- разбор ссылок ---------- */
  KC.parseSource = (raw, embedHosts) => {
    const s = String(raw || '').trim();
    if (!s) return null;
    const yt = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
    if (yt) return { type: 'yt', id: yt[1] };
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase();
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      const i = parts.findIndex((x) => /^\d{6,12}$/.test(x));
      if (i >= 0) {
        const o = { type: 'vimeo', id: parts[i] };
        const hash = u.searchParams.get('h') || (/^[a-f0-9]{6,20}$/i.test(parts[i + 1] || '') ? parts[i + 1] : '');
        if (hash) o.h = hash;
        return o;
      }
    }
    if (host === 'rutube.ru' || host.endsWith('.rutube.ru')) {
      const m = u.pathname.match(/\/([a-f0-9]{32})(?:\/|$)/i);
      if (m) return { type: 'rutube', id: m[1].toLowerCase() };
    }
    if ((embedHosts || []).some((e) => host === e || host.endsWith('.' + e))) {
      u.protocol = 'https:';
      return { type: 'embed', url: u.href };
    }
    return { type: 'url', url: s };
  };

  // Человекочитаемое описание источника и уровня синхронизации
  KC.describeSource = (src) => {
    switch (src.type) {
      case 'yt': return { name: 'YouTube', sync: 'full' };
      case 'vimeo': return { name: 'Vimeo', sync: 'full' };
      case 'rutube': return { name: 'RuTube', sync: 'full' };
      case 'embed': return { name: new URL(src.url).hostname, sync: 'manual' };
      case 'file': return { name: 'Файл ' + src.name, sync: 'full' };
      default: return { name: /\.m3u8(\?|#|$)/i.test(src.url) ? 'Поток HLS' : 'Прямая ссылка', sync: 'full' };
    }
  };

  KC.createPlayer = (src, h, fileUrl) => {
    switch (src.type) {
      case 'yt': return makeYT(src.id, h);
      case 'vimeo': return makeVimeo(src, h);
      case 'rutube': return makeRutube(src.id, h);
      case 'embed': return makeEmbed(src.url, h);
      case 'file': return makeVideo(fileUrl, h);
      default: return makeVideo(src.url, h);
    }
  };
})();
