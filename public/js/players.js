'use strict';
// Адаптеры плееров. Общий интерфейс:
//   { caps:{control}, tol?, time(), playing(), play(), pause(), seek(t), nudge?(drift), destroy() }
// tol: на сколько секунд плеер «грубее» обычного (VK отдаёт время целыми секундами)
// hooks: { host, emit(action,t), suppressed(), toast(text), onReady(p), manual(on, why) }
(function () {
  const KC = window.KC;
  const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
  const VIMEO_API = 'https://player.vimeo.com/api/player.js';
  const VK_HOSTS = ['vk.ru', 'vk.com']; // официальный скрипт API лежит на vk.ru; vk.com как запасной
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
    let hls = null, dead = false, rateTimer = null, baseRate = 1, nudging = false;
    let selfSeeks = 0, selfSeekTimer = null;
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
      caps: { control: true, rate: true },
      time: () => v.currentTime,
      buffering: () => v.seeking || (!v.paused && v.readyState < 3),
      playing: () => !v.paused && !v.ended,
      play: () => { const r = v.play(); if (r && r.catch) r.catch(() => h.toast('Браузер заблокировал автозапуск. Нажмите ▶ в плеере')); },
      pause: () => v.pause(),
      seek: (t) => {
        selfSeeks++;
        clearTimeout(selfSeekTimer);
        selfSeekTimer = setTimeout(() => { selfSeeks = 0; }, 5000);
        v.currentTime = t;
      },
      rate: () => v.playbackRate,
      setRate: (r) => { baseRate = r; if (!nudging) v.playbackRate = r; },
      // При мягкой коррекции сохраняем выбранную пользователем скорость.
      nudge(drift) {
        clearTimeout(rateTimer);
        nudging = true;
        if (!drift) {
          v.playbackRate = baseRate;
          rateTimer = setTimeout(() => { nudging = false; }, 250);
          return;
        }
        v.playbackRate = baseRate * (drift > 0 ? 0.95 : 1.05);
        rateTimer = setTimeout(() => { v.playbackRate = baseRate; nudging = false; }, Math.min(8000, (Math.abs(drift) / 0.05) * 1000));
      },
      destroy() {
        dead = true;
        clearTimeout(rateTimer);
        clearTimeout(selfSeekTimer);
        if (hls) hls.destroy();
        v.pause(); v.removeAttribute('src'); v.load(); v.remove();
      },
    };
    v.addEventListener('loadedmetadata', () => h.onReady(p), { once: true });
    v.addEventListener('play', () => h.emit('play', v.currentTime));
    v.addEventListener('pause', () => { if (!v.ended) h.emit('pause', v.currentTime); });
    v.addEventListener('seeked', () => {
      if (selfSeeks > 0) { selfSeeks--; return; }
      h.emit('seek', v.currentTime);
    });
    v.addEventListener('ratechange', () => { if (!nudging) { baseRate = v.playbackRate; h.emit('rate', v.currentTime, v.playbackRate); } });
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
    let yt = null, ok = false, dead = false, poll = null, last = 0, lastAt = 0;
    let lastStable = -1;
    const p = {
      caps: { control: true, rate: true },
      time: () => (ok ? yt.getCurrentTime() : 0),
      buffering: () => ok && yt.getPlayerState() === 3,
      playing: () => ok && yt.getPlayerState() === 1,
      play: () => ok && yt.playVideo(),
      pause: () => ok && yt.pauseVideo(),
      seek: (t) => ok && yt.seekTo(t, true),
      rate: () => (ok ? yt.getPlaybackRate() : 1),
      setRate: (r) => ok && yt.setPlaybackRate(r),
      destroy() { dead = true; clearInterval(poll); try { yt && yt.destroy(); } catch {} box.remove(); },
    };
    // YouTube не сообщает о перемотке событием, поэтому раз в 500 мс ищем «скачок» времени
    function tick() {
      const now = performance.now();
      const t = yt.getCurrentTime();
      const elapsed = now - lastAt;
      const late = elapsed > 1500;
      const expected = last + (yt.getPlayerState() === 1 ? (elapsed / 1000) * yt.getPlaybackRate() : 0);
      if (!late && Math.abs(t - expected) > 1.5 && !h.suppressed()) h.emit('seek', t);
      last = t;
      lastAt = now;
    }
    loadYT().then(() => {
      if (dead) return;
      yt = new YT.Player(box.id, {
        videoId: id, width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, fs: 0, origin: location.origin },
        events: {
          onReady() { ok = true; last = yt.getCurrentTime(); lastAt = performance.now(); poll = setInterval(tick, 500); h.onReady(p); },
          onStateChange(e) {
            const state = e.data, prev = lastStable;
            if (state !== 3) lastStable = state;
            if (h.suppressed()) return;
            // Возврат из буферизации не считается новым нажатием Play.
            if (state === 1 && prev !== 1) h.emit('play', yt.getCurrentTime());
            else if (state === 2) h.emit('pause', yt.getCurrentTime());
          },
          onPlaybackRateChange(e) { h.emit('rate', yt.getCurrentTime(), e.data); },
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

  /* ---------- RuTube (postMessage API, rutube/RutubePlayerJSAPI) ---------- */
  // Команды: player:play, player:pause, player:setCurrentTime {time}.
  // События: player:ready, player:changeState {state: playing|paused|stopped|...}, player:currentTime {time},
  // player:rollState {state: play|complete} (реклама). Если за 10 секунд не пришло ни одного события,
  // честно переключаемся на ручную синхронизацию.
  function makeRutube(src, h) {
    const q = src.p ? `?p=${encodeURIComponent(src.p)}` : '';
    const frame = makeFrame(h.host, `https://rutube.ru/play/embed/${src.id}${q}`, 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    let playing = false, t = 0, tAt = performance.now(), heard = false, dead = false, ad = false;
    const cur = () => (playing ? t + (performance.now() - tAt) / 1000 : t);
    const set = (sec) => { t = sec; tAt = performance.now(); };
    const post = (type, data = {}) => { try { frame.contentWindow.postMessage(JSON.stringify({ type, data }), '*'); } catch {} };
    const p = {
      caps: { control: true },
      time: cur,
      playing: () => playing,
      play: () => post('player:play'),
      pause: () => post('player:pause'),
      seek: (s) => { set(s); post('player:setCurrentTime', { time: s }); },
      destroy() { dead = true; window.removeEventListener('message', onMsg); clearTimeout(watch); post('player:remove'); frame.remove(); },
    };
    function onMsg(e) {
      if (e.source !== frame.contentWindow) return;
      let m = e.data;
      if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
      if (!m || typeof m.type !== 'string' || !m.type.startsWith('player:')) return;
      if (!heard) { heard = true; clearTimeout(watch); h.onReady(p); }
      const d = m.data || {};
      if (m.type === 'player:rollState') { ad = d.state === 'play'; return; } // во время рекламы ничего не синхронизируем
      if (ad) return;
      if (m.type === 'player:currentTime' && isFinite(d.time)) {
        // перемотка пользователем: время «прыгнуло» относительно того, что мы ожидали
        const jump = Math.abs(d.time - cur()) > 1.5;
        set(d.time);
        if (jump && !h.suppressed()) h.emit('seek', t);
      } else if (m.type === 'player:changeState') {
        if (d.state !== 'playing' && d.state !== 'paused') return; // stopped, lockScreen... не про play/pause
        const now = d.state === 'playing';
        if (now !== playing) { const at = cur(); playing = now; set(at); h.emit(now ? 'play' : 'pause', at); }
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

  /* ---------- VK Видео (официальный JS API: VK.VideoPlayer, dev.vk.ru/ru/widgets/video) ---------- */
  // Нужен параметр js_api=1 в адресе плеера. Время VK отдаёт целыми секундами (tol: 1).
  // Если скрипт API не загрузился или плеер за 15 секунд не ответил, включается ручной режим.
  function makeVK(src, h) {
    let dead = false, vp = null, frame = null, heard = false, ad = false, playing = false, t = 0, tAt = performance.now(), watch = null;
    const cur = () => (playing ? t + (performance.now() - tAt) / 1000 : t);
    const set = (sec) => { if (isFinite(sec)) { t = sec; tAt = performance.now(); } };
    const p = {
      caps: { control: true },
      tol: 1,
      time: cur,
      playing: () => playing,
      play() { try { vp && vp.play(); } catch {} },
      pause() { try { vp && vp.pause(); } catch {} },
      seek(s) { set(s); try { vp && vp.seek(s); } catch {} },
      destroy() { dead = true; clearTimeout(watch); try { vp && vp.destroy(); } catch {} if (frame) frame.remove(); },
    };
    const giveUp = () => { if (dead || heard) return; p.caps.control = false; h.manual(true, 'vk'); };
    const query = `oid=${src.oid}&id=${src.id}${src.h ? '&hash=' + src.h : ''}&hd=2&js_api=1`;
    (async () => {
      let host = null;
      for (const hh of VK_HOSTS) {
        try { await KC.loadScript(`https://${hh}/js/api/videoplayer.js`); } catch { continue; }
        if (window.VK && VK.VideoPlayer) { host = hh; break; }
      }
      if (dead) return;
      if (!host) return giveUp();
      // сначала плеер API, потом iframe: так событие inited не пропустится
      frame = makeFrame(h.host, `https://${host}/video_ext.php?${query}`, 'autoplay; encrypted-media; fullscreen; picture-in-picture');
      try { vp = VK.VideoPlayer(frame); } catch { return giveUp(); }
      const heardIt = () => { if (!heard) { heard = true; clearTimeout(watch); h.onReady(p); } };
      const on = (ev, fn) => vp.on(ev, (st) => { if (dead) return; heardIt(); fn(st || {}); });
      on('inited', () => {});
      on('adStarted', () => { ad = true; });
      on('adCompleted', () => { ad = false; });
      const start = (st) => { if (ad) return; set(st.time); playing = true; h.emit('play', cur()); };
      on('started', start);
      on('resumed', start);
      on('paused', (st) => { if (ad) return; set(st.time); playing = false; h.emit('pause', cur()); });
      on('ended', (st) => { set(st.time); playing = false; });
      on('timeupdate', (st) => {
        if (ad || !isFinite(st.time)) return;
        const jump = Math.abs(st.time - cur()) > 2.5; // время целое, поэтому порог больше
        set(st.time);
        if (jump && !h.suppressed()) h.emit('seek', st.time);
      });
      on('error', () => h.toast('VK Видео не смогло открыть это видео (возможно, оно закрытое или встраивание запрещено)'));
      watch = setTimeout(giveUp, 15000);
    })();
    return p;
  }

  /* ---------- разбор ссылок ---------- */
  KC.parseSource = (raw) => {
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
      if (m) {
        const o = { type: 'rutube', id: m[1].toLowerCase() };
        const key = u.searchParams.get('p');
        if (key && /^[\w-]{6,64}$/.test(key)) o.p = key;
        return o;
      }
    }
    if (/^(m\.)?(vk\.com|vk\.ru|vkvideo\.ru)$/.test(host)) {
      // ссылка на страницу (video-123_456, в том числе внутри ?z=) или код встраивания (video_ext.php?oid=&id=&hash=)
      const q = u.searchParams;
      if (/^\/video_ext\.php/.test(u.pathname) && /^-?\d{1,12}$/.test(q.get('oid') || '') && /^\d{1,12}$/.test(q.get('id') || '')) {
        const o = { type: 'vk', oid: q.get('oid'), id: q.get('id') };
        if (/^[a-f0-9]{6,32}$/i.test(q.get('hash') || '')) o.h = q.get('hash');
        return o;
      }
      let dec = u.pathname + '?' + u.search;
      try { dec = decodeURIComponent(dec); } catch {}
      const m = dec.match(/video(-?\d{1,12})_(\d{1,12})(?:_([a-f0-9]{6,32}))?/i);
      if (m) {
        const o = { type: 'vk', oid: m[1], id: m[2] };
        if (m[3]) o.h = m[3];
        return o;
      }
    }
    return { type: 'url', url: s };
  };

  // Человекочитаемое описание источника и уровня синхронизации
  KC.describeSource = (src) => {
    switch (src.type) {
      case 'yt': return { name: 'YouTube', sync: 'full' };
      case 'vimeo': return { name: 'Vimeo', sync: 'full' };
      case 'rutube': return { name: 'RuTube', sync: 'full' };
      case 'vk': return { name: 'VK Видео', sync: 'full' };
      case 'file': return { name: 'Файл ' + src.name, sync: 'full' };
      default: return { name: /\.m3u8(\?|#|$)/i.test(src.url) ? 'Поток HLS' : 'Прямая ссылка', sync: 'full' };
    }
  };

  // Обычная ссылка на источник (для «Открыть отдельно» в ручном режиме)
  KC.sourceLink = (src) => {
    if (!src) return '';
    if (src.type === 'rutube') return `https://rutube.ru/video/${src.id}/` + (src.p ? `?p=${encodeURIComponent(src.p)}` : '');
    if (src.type === 'vk') return `https://vk.com/video${src.oid}_${src.id}` + (src.h ? `_${src.h}` : '');
    return '';
  };

  KC.createPlayer = (src, h, fileUrl) => {
    switch (src.type) {
      case 'yt': return makeYT(src.id, h);
      case 'vimeo': return makeVimeo(src, h);
      case 'rutube': return makeRutube(src, h);
      case 'vk': return makeVK(src, h);
      case 'file': return makeVideo(fileUrl, h);
      default: return makeVideo(src.url, h);
    }
  };
})();
