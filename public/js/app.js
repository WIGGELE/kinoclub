'use strict';
(function () {
  const KC = window.KC;
  const { $, $$, toast } = KC;

  let ws = null, roomCode = '', myName = '', myId = '', epoch = '', lastEid = 0;
  let wantRoom = false, inRoom = false, connected = false;
  let retryTimer = null, retries = 0, watchdog = null, pingTimer = null, pongTimer = null;
  let oneWay = 0.05;               // оценка односторонней задержки до сервера, сек
  let source = null, player = null, curToken = null, manualActive = false, manualWhy = '';
  let myFile = null, myFileUrl = null;
  let suppressUntil = 0;
  let rateLockUntil = 0;
  let lastAutoSeek = 0;
  let armed = false;
  let known = { playing: false, time: 0, rate: 1, at: Date.now() };
  let dmColor = Math.min(7, Math.max(0, Number(KC.store.get('kc_dmcolor', 0)) | 0));
  const users = new Map();

  // id вкладки: переживает перезагрузку и переподключение, но не общий между вкладками
  const myCid = (() => {
    try { let c = sessionStorage.getItem('kc_cid'); if (!c) { c = KC.randomId(12); sessionStorage.setItem('kc_cid', c); } return c; }
    catch { return KC.randomId(12); }
  })();

  /* ---------- профиль ---------- */
  const profile = { name: '', avatar: null };
  try { profile.name = localStorage.getItem('kc_name') || ''; } catch {}
  {
    const a = KC.store.get('kc_avatar', null);
    if (a && (Number.isInteger(a.p) || (typeof a.data === 'string' && typeof a.mime === 'string'))) profile.avatar = a;
    else { profile.avatar = { p: Math.floor(Math.random() * KC.AVATAR_PRESETS) }; KC.store.set('kc_avatar', profile.avatar); }
  }
  const avatarForServer = () => (profile.avatar.data ? { data: profile.avatar.data } : { p: profile.avatar.p });
  const localAvatar = (a, name) => (a.data
    ? KC.avatarEl({ name }, { src: `data:${a.mime};base64,${a.data}` })
    : KC.avatarEl({ name, av: 'p' + a.p }));
  function renderMine() {
    const name = profile.name || 'Гость';
    $('#landingAva').replaceChildren(localAvatar(profile.avatar, name));
    const me = $('#meBtn');
    me.replaceChildren(localAvatar(profile.avatar, name), $('#meName'));
    $('#meName').textContent = name;
  }

  /* ---------- утилиты ---------- */
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const suppress = (ms = 700) => { suppressUntil = Date.now() + ms; };
  const isSuppressed = () => Date.now() < suppressUntil;
  const est = () => (known.playing ? known.time + ((Date.now() - known.at) / 1000) * (known.rate || 1) : known.time);
  const setKnown = (playing, time, rate = known.rate || 1) => { known = { playing, time, rate, at: Date.now() }; };

  /* ---------- вход ---------- */
  $('#nameInput').value = profile.name;
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (urlRoom) $('#codeInput').value = urlRoom;

  function randomCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
  }
  function setConnecting(on) {
    $('#createBtn').disabled = on;
    $('#joinBtn').disabled = on;
    $('#createBtn').textContent = on ? 'Подключаюсь…' : 'Создать комнату';
  }
  function enter(code) {
    const name = $('#nameInput').value.trim();
    if (!name) { $('#nameInput').focus(); return toast('Сначала введите своё имя'); }
    if (!/^[A-Z0-9]{3,12}$/.test(code)) { $('#codeInput').focus(); return toast('Код комнаты: 3–12 букв или цифр'); }
    try { localStorage.setItem('kc_name', name); } catch {}
    profile.name = name;
    myName = name;
    roomCode = code;
    wantRoom = true;
    retries = 0;
    setConnecting(true);
    renderMine();
    connect();
  }
  $('#createBtn').onclick = () => enter(randomCode());
  $('#joinForm').onsubmit = (e) => { e.preventDefault(); enter($('#codeInput').value.trim().toUpperCase()); };

  /* ---------- соединение ---------- */
  function joinMsg() {
    const m = { type: 'join', room: roomCode, name: profile.name, cid: myCid, avatar: avatarForServer() };
    // После переподключения (в т.ч. после «сна» Render) можно вернуть комнату в прежнее состояние
    if (inRoom && source) m.resume = { source, time: est(), rate: known.rate || 1 };
    return m;
  }
  function detach() {
    if (!ws) return;
    const s = ws;
    ws = null;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try { s.close(); } catch {}
  }
  function connect() {
    clearTimeout(retryTimer);
    clearTimeout(watchdog);
    detach();
    const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws = sock;
    sock.onopen = () => { clearTimeout(watchdog); sock.send(JSON.stringify(joinMsg())); };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMsg(m);
    };
    sock.onclose = () => { if (ws === sock) onDown(); };
    sock.onerror = () => {};
    // Холодный старт Render может занять около минуты: не висим на мёртвой попытке вечно
    watchdog = setTimeout(() => { if (ws === sock && sock.readyState === 0) { detach(); onDown(); } }, 20000);
  }
  function onDown() {
    connected = false;
    stopPing();
    if (!wantRoom) return;
    if (inRoom) setConn(false);
    else if (retries === 0) toast('Сервер просыпается, подключаюсь… Это может занять до минуты');
    const d = Math.min(10000, 1000 * 2 ** Math.min(retries, 4)) * (0.7 + Math.random() * 0.6);
    retries++;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, d);
  }
  function reconnectNow() {
    detach();
    connected = false;
    stopPing();
    if (inRoom) setConn(false);
    retries = 0;
    connect();
  }
  function setConn(on) {
    const c = $('#conn');
    c.textContent = on ? 'онлайн' : 'переподключаюсь…';
    c.classList.toggle('off', !on);
  }
  function startPing() {
    stopPing();
    const ping = () => {
      if (!connected) return;
      send({ type: 'ping', t: Date.now() });
      clearTimeout(pongTimer);
      pongTimer = setTimeout(reconnectNow, 10000); // сервер молчит: соединение «зависло»
    };
    pingTimer = setInterval(ping, 20000);
    ping();
  }
  function stopPing() { clearInterval(pingTimer); clearTimeout(pongTimer); }
  function wake() {
    if (!wantRoom || !inRoom) return;
    if (!ws || ws.readyState !== 1) { retries = 0; connect(); }
    else if (connected) { send({ type: 'ping', t: Date.now() }); clearTimeout(pongTimer); pongTimer = setTimeout(reconnectNow, 6000); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  window.addEventListener('online', wake);

  /* ---------- сообщения сервера ---------- */
  // Событие уже обработано (повторная доставка или старая комната)?
  function dup(m) {
    if (!m.eid) return false;
    if (m.eid <= lastEid) return true;
    lastEid = m.eid;
    return false;
  }
  const sameSrc = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function onMsg(m) {
    switch (m.type) {
      case 'init': {
        const first = !epoch, same = epoch === m.epoch;
        myId = m.you;
        connected = true;
        inRoom = true;
        retries = 0;
        setConn(true);
        setConnecting(false);
        $('#landing').hidden = true;
        $('#room').hidden = false;
        $('#roomCode').textContent = roomCode;
        history.replaceState(null, '', location.pathname + '?room=' + roomCode);
        if (first) { $('#msgs').replaceChildren(); m.history.forEach(addMsg); }
        else if (same) m.history.filter((h) => h.eid > lastEid).forEach(addMsg);
        else addSys('Сервер перезапускался, комната создана заново');
        epoch = m.epoch;
        lastEid = m.eid;
        renderUsers(m.users);
        renderRecent(m.recent);
        setKnown(m.state.playing, m.state.time, m.state.rate || 1);
        if (!sameSrc(source, m.source) || !source) setSourceLocal(m.source);
        else applyState(m.state, false);
        startPing();
        break;
      }
      case 'users': renderUsers(m.users); break;
      case 'source':
        setKnown(false, 0, 1);
        rateLockUntil = 0;
        armed = false;
        setSourceLocal(m.source);
        renderRecent(m.recent);
        if (m.by && m.byId !== myId) toast(`${m.by} включил(а) новое видео`);
        break;
      case 'state': {
        if (m.by) {
          const t = { play: 'нажал(а) play', pause: 'поставил(а) на паузу', seek: 'перемотал(а)', rate: 'выбрал(а) скорость ×' + (m.rate || 1) }[m.action];
          if (t) toast(`${m.by} ${t}`);
        }
        applyState(m, false);
        break;
      }
      case 'sync': applyState(m, true); break;
      case 'chat':
        if (dup(m)) break;
        if (m.mode !== 'fly') addMsg(m);
        if (KC.settings.danmaku && (m.mode === 'fly' || KC.settings.dmChat)) {
          KC.danmaku.add(m.text, { color: KC.DM_COLORS[m.color] || '#fff', mine: m.id === myId });
        }
        break;
      case 'sys': addSys(m.text); break;
      case 'reaction':
        if (dup(m)) break;
        // Своё эмодзи мы уже показали сразу при нажатии; здесь только звук (его разрешил сервер)
        if (m.id !== myId && KC.settings.reactions) floatEmoji(m.emoji, m.name);
        if (m.sound) KC.audio.play(m.sound);
        break;
      case 'countdown':
        if (dup(m)) break;
        startCountdown(m.by);
        break;
      case 'pong': {
        clearTimeout(pongTimer);
        const rtt = Math.min(3000, Math.max(0, Date.now() - m.t));
        oneWay = oneWay * 0.7 + (rtt / 2000) * 0.3;
        break;
      }
      case 'error':
        toast(m.message);
        if (!inRoom) { wantRoom = false; detach(); setConnecting(false); }
        break;
    }
  }

  /* ---------- синхронизация ---------- */
  // isSync: периодическая сверка от сервера (мягкая коррекция), иначе событие от участника
  function applyState(s, isSync) {
    const rate = s.rate || 1;
    // После смены скорости игнорируем запоздавшие периодические sync-сообщения.
    if (s.action === 'rate') rateLockUntil = Date.now() + 6000;
    if (isSync && Date.now() < rateLockUntil) return;

    const target = s.time + (s.playing ? oneWay * rate : 0);
    setKnown(s.playing, target, rate);
    if (!player || !player.caps.control) return;
    armed = true;

    const needRate = !!player.caps.rate && Math.abs(player.rate() - rate) > 0.01;
    const diff = player.time() - target;
    const ad = Math.abs(diff);
    const soft = isSync && s.playing && !!player.nudge;

    // При смене скорости позицию вообще не перематываем.
    let tolerance;
    if (s.action === 'rate') tolerance = Infinity;
    else if (!s.playing) tolerance = isSync ? 1 : 0.4;
    else if (isSync) tolerance = 3;
    else tolerance = 1.5;

    let needSeek = ad > tolerance + (player.tol || 0);
    if (needSeek && isSync) {
      if (player.buffering && player.buffering()) needSeek = false;
      else if (Date.now() - lastAutoSeek < 6000) needSeek = false;
    }

    const needPlay = s.playing && !player.playing();
    const needPause = !s.playing && player.playing();
    if (!needRate && !needSeek && !needPlay && !needPause) {
      if (soft) player.nudge(ad > 0.3 ? diff : 0);
      return;
    }

    suppress();
    if (needRate) player.setRate(rate);
    if (needSeek) {
      player.seek(target);
      if (player.nudge) player.nudge(0);
      if (isSync) lastAutoSeek = Date.now();
    }
    if (needPlay) player.play();
    if (needPause) player.pause();
  }


  // Локальное действие пользователя -> остальным
  function emit(action, t, rate) {
    if ((isSuppressed() && action !== 'rate') || !connected || !player || !player.caps.control) return;
    const e = est();
    if (action === 'play' && known.playing && Math.abs(t - e) < 2) return;
    if (action === 'pause' && !known.playing) return;
    if (action === 'seek' && Math.abs(t - e) < 1.5) return;
    if (action === 'rate') {
      if (!armed || !player.caps.rate || Math.abs(rate - known.rate) < 0.01) return;
      known = { playing: known.playing, time: e, rate, at: Date.now() };
      rateLockUntil = Date.now() + 6000;
    } else {
      setKnown(action === 'play' || (action === 'seek' && known.playing), t);
    }
    send({ type: 'control', action, time: action === 'rate' ? e : t, ...(action === 'rate' ? { rate } : {}) });
  }

  /* ---------- источник и плеер ---------- */
  function destroyPlayer() {
    curToken = null;
    if (player) { try { player.destroy(); } catch {} player = null; }
    $('#playerHost').replaceChildren();
  }
  function updateNow() {
    const n = $('#now');
    n.replaceChildren();
    if (!source) return;
    const d = KC.describeSource(source);
    const manual = d.sync === 'manual' || manualActive;
    const b = document.createElement('span');
    b.className = 'badge ' + (manual ? 'warn' : 'ok');
    b.textContent = d.name.startsWith('Файл') ? d.name : d.name + (manual ? ' · ручная синхронизация' : ' · синхронизация');
    n.appendChild(b);
    if (source.url) {
      const u = document.createElement('span');
      u.className = 'url';
      u.textContent = source.url;
      n.appendChild(u);
    }
  }
  function showManual(on, why) {
    manualActive = on;
    manualWhy = why || '';
    const banner = $('#manualBanner');
    if (!on) { banner.hidden = true; return updateNow(); }
    const name = why === 'vk' ? 'VK Видео' : 'RuTube';
    $('#manualText').textContent = `${name} не ответил на команды управления, поэтому play, пауза и перемотка сейчас не синхронизируются. Нажмите «Старт вместе»: у всех пойдёт отсчёт 3-2-1, и каждый жмёт play. Иногда помогает отключить блокировщик рекламы и защиту от отслеживания для этого сайта, затем обновить страницу.`;
    const a = $('#openTab');
    const link = KC.sourceLink(source);
    a.hidden = !link;
    if (link) a.href = link;
    banner.hidden = false;
    updateNow();
  }
  $('#manualClose').onclick = () => { $('#manualBanner').hidden = true; };
  $('#startTogether').onclick = () => send({ type: 'countdown' });

  let cdTimer = null;
  function startCountdown(by) {
    clearTimeout(cdTimer);
    const box = $('#countdown');
    box.hidden = false;
    let n = 3;
    const step = () => {
      if (n > 0) { $('#cdNum').textContent = n; $('#cdLbl').textContent = `${by} предлагает стартовать вместе`; n--; cdTimer = setTimeout(step, 1000); }
      else { $('#cdNum').textContent = '▶'; $('#cdLbl').textContent = 'Жмите play!'; cdTimer = setTimeout(() => { box.hidden = true; }, 1500); }
    };
    step();
  }

  function setSourceLocal(src, forceFile) {
    destroyPlayer();
    source = src;
    manualActive = false;
    $('#manualBanner').hidden = true;
    $('#need').hidden = true;
    $('#empty').hidden = !!src;
    updateNow();
    if (!src) return;
    if (src.type === 'file') {
      const match = myFile && myFile.name === src.name && myFile.size === src.size;
      if (!(myFile && (match || forceFile))) {
        $('#needName').textContent = src.name;
        $('#need').hidden = false;
        return;
      }
    }
    // События устаревшего плеера не должны влиять на новый
    const token = {};
    curToken = token;
    const live = (fn) => (...a) => (curToken === token ? fn(...a) : undefined);
    const hooks = {
      host: $('#playerHost'),
      emit: live(emit),
      suppressed: () => isSuppressed(),
      toast,
      onReady: live((p) => { if (player === p) { send({ type: 'needState' }); } }),
      manual: live(showManual),
    };
    try { player = KC.createPlayer(src, hooks, myFileUrl); }
    catch (e) { console.error(e); toast('Не удалось открыть этот источник'); }
  }

  /* ---------- выбор источника ---------- */
  const looksLikeMedia = (u) => /\.(mp4|m4v|webm|ogv|mov|m3u8)(\?|#|$)/i.test(u);
  function showBadge(text, warn) {
    const b = $('#urlBadge');
    b.hidden = !text;
    b.textContent = text || '';
    b.classList.toggle('warn', !!warn);
    $('#urlInput').style.paddingRight = text ? Math.max(70, text.length * 7 + 24) + 'px' : '';
  }
  $('#urlInput').addEventListener('input', () => {
    const src = KC.parseSource($('#urlInput').value);
    if (!$('#urlInput').value.trim()) return showBadge('');
    if (!src) return showBadge('не ссылка', true);
    const d = KC.describeSource(src);
    if (src.type === 'url' && !looksLikeMedia(src.url)) return showBadge('не похоже на видеофайл', true);
    showBadge(d.name + (d.sync === 'manual' ? ' · вручную' : ' ✓'), d.sync === 'manual');
  });
  $('#urlForm').onsubmit = (e) => {
    e.preventDefault();
    const src = KC.parseSource($('#urlInput').value);
    if (!src) return toast('Нужна ссылка, начинающаяся с http:// или https://');
    if (src.type === 'url' && location.protocol === 'https:' && /^http:/i.test(src.url)) {
      return toast('Сайт открыт по https, поэтому ссылка на видео тоже должна быть https');
    }
    send({ type: 'setSource', source: src });
    $('#urlInput').value = '';
    showBadge('');
  };
  function handleFile(f, announce) {
    if (!f) return;
    if (myFileUrl) URL.revokeObjectURL(myFileUrl);
    myFile = f;
    myFileUrl = URL.createObjectURL(f);
    if (announce) send({ type: 'setSource', source: { type: 'file', name: f.name, size: f.size } });
    else if (source && source.type === 'file') {
      if (source.name !== f.name || source.size !== f.size) toast('Похоже, это другой файл. Синхронизация может не совпасть');
      setSourceLocal(source, true);
    }
  }
  $('#fileInput').onchange = (e) => { handleFile(e.target.files[0], true); e.target.value = ''; };
  $('#needInput').onchange = (e) => { handleFile(e.target.files[0], false); e.target.value = ''; };

  function renderRecent(list) {
    const box = $('#recent');
    const items = (list || []).filter((s) => s.type !== 'file');
    box.hidden = items.length < 1;
    if (!items.length) return box.replaceChildren();
    const head = document.createElement('span');
    head.textContent = 'Недавние в комнате:';
    const chips = items.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      const d = KC.describeSource(s);
      const tail = s.url ? s.url.replace(/^https?:\/\/(www\.)?/, '') : s.type === 'vk' ? `${s.oid}_${s.id}` : s.id;
      b.textContent = `${d.name}: ${tail}`;
      b.title = s.url || tail;
      b.onclick = () => { if (!sameSrc(s, source)) send({ type: 'setSource', source: s }); };
      return b;
    });
    box.replaceChildren(head, ...chips);
  }

  /* ---------- зрители и чат ---------- */
  function renderUsers(list) {
    users.clear();
    list.forEach((u) => users.set(u.id, u));
    $('#count').textContent = list.length;
    const frag = document.createDocumentFragment();
    list.forEach((u) => {
      const d = document.createElement('div');
      d.className = 'user';
      const n = document.createElement('span');
      n.textContent = u.name + (u.id === myId ? ' (вы)' : '');
      d.append(KC.avatarEl(u, { room: roomCode }), n);
      frag.appendChild(d);
    });
    $('#userList').replaceChildren(frag);
    const me = users.get(myId);
    if (me) myName = me.name;
  }
  function pushMsg(el) {
    const box = $('#msgs');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.appendChild(el);
    while (box.childElementCount > 200) box.firstElementChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  }
  function addMsg(m) {
    const d = document.createElement('div');
    d.className = 'msg';
    const u = users.get(m.id);
    const body = document.createElement('div');
    body.className = 'body';
    const b = document.createElement('b');
    b.style.color = KC.colorFor(m.name);
    b.textContent = m.name;
    const s = document.createElement('span');
    s.textContent = m.text;
    body.append(b, s);
    d.append(KC.avatarEl({ id: m.id, name: m.name, av: (u && u.av) || m.av }, { room: roomCode }), body);
    pushMsg(d);
  }
  function addSys(text) {
    const d = document.createElement('div');
    d.className = 'sys';
    d.textContent = text;
    pushMsg(d);
  }
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    send({ type: 'chat', text, color: dmColor });
    $('#chatInput').value = '';
  };

  /* ---------- летающие комментарии: отправка ---------- */
  function paintColor() { $('#dmColor i').style.background = KC.DM_COLORS[dmColor]; }
  $('#dmColor').onclick = () => {
    dmColor = (dmColor + 1) % KC.DM_COLORS.length;
    KC.store.set('kc_dmcolor', dmColor);
    paintColor();
  };
  $('#dmForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#dmInput').value.trim();
    if (!text) return;
    if (!connected) return toast('Нет соединения');
    send({ type: 'chat', mode: 'fly', text, color: dmColor });
    $('#dmInput').value = '';
  };

  /* ---------- реакции ---------- */
  const bucket = { n: 5, t: performance.now() };
  function localAllow() { // зеркало серверного лимита (2.5/с, пачка 5): не показываем то, что сервер отбросит
    const now = performance.now();
    bucket.n = Math.min(5, bucket.n + ((now - bucket.t) / 1000) * 2.5);
    bucket.t = now;
    if (bucket.n < 1) return false;
    bucket.n -= 1;
    return true;
  }
  function sendReaction(emoji) {
    if (!connected) return toast('Нет соединения');
    if (!localAllow()) return;
    KC.emoji.remember(emoji);
    if (KC.settings.reactions) floatEmoji(emoji, '');
    send({ type: 'reaction', emoji });
  }
  const MAX_FLOATS = 24;
  function floatEmoji(emoji, name) {
    const box = $('#floaty');
    while (box.childElementCount >= MAX_FLOATS) box.firstElementChild.remove();
    const s = document.createElement('span');
    s.className = 'float';
    s.textContent = emoji;
    if (name) { const sm = document.createElement('small'); sm.textContent = name; s.appendChild(sm); }
    s.style.left = 6 + Math.random() * 82 + '%';
    const kill = () => s.remove();
    s.addEventListener('animationend', kill);
    setTimeout(kill, 3200); // страховка, если анимация не стартовала (скрытая вкладка)
    box.appendChild(s);
  }
  KC.QUICK.forEach((em) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.setAttribute('aria-label', 'Эмодзи ' + em);
    b.onclick = () => sendReaction(em);
    $('#quick').appendChild(b);
  });

  /* ---------- панели ---------- */
  const POPS = { emoji: ['#emojiPop', '#btnEmoji'], settings: ['#settingsPop', '#btnSettings'], src: ['#srcPop', '#srcBtn'] };
  function closePops(except) {
    for (const [k, [p]] of Object.entries(POPS)) if (k !== except) $(p).hidden = true;
  }
  function togglePop(name) {
    const pop = $(POPS[name][0]);
    const open = pop.hidden;
    closePops(name);
    pop.hidden = !open;
    if (open && name === 'emoji' && matchMedia('(pointer:fine)').matches) $('#emojiSearch').focus();
  }
  for (const [k, [, btn]] of Object.entries(POPS)) $(btn).onclick = () => togglePop(k);
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.pop, #btnEmoji, #btnSettings, #srcBtn')) closePops();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closePops();
    if (!$('#profile').hidden) $('#profile').hidden = true;
    if ($('#stageWrap').classList.contains('pseudo-fs')) setPseudoFs(false);
  });

  /* ---------- настройки ---------- */
  const fmt = {
    volume: (v) => Math.round(v * 100) + '%', dmOpacity: (v) => Math.round(v * 100) + '%', dmDensity: (v) => Math.round(v * 100) + '%',
    dmSpeed: (v) => '×' + v.toFixed(1), dmSize: (v) => v + 'px',
  };
  function syncSettingsUI() {
    $$('[data-s]').forEach((inp) => {
      const k = inp.dataset.s, v = KC.settings[k];
      if (inp.type === 'checkbox') inp.checked = v; else inp.value = v;
      const out = inp.parentElement.querySelector('output');
      if (out && fmt[k]) out.textContent = fmt[k](v);
    });
    const snd = $('#btnSound'), dm = $('#btnDm');
    snd.textContent = KC.settings.sound ? '🔊' : '🔇';
    snd.setAttribute('aria-pressed', String(KC.settings.sound));
    dm.setAttribute('aria-pressed', String(KC.settings.danmaku));
  }
  $$('[data-s]').forEach((inp) => inp.addEventListener('input', () => {
    KC.setSetting(inp.dataset.s, inp.type === 'checkbox' ? inp.checked : Number(inp.value));
  }));
  $('#btnSound').onclick = () => KC.setSetting('sound', !KC.settings.sound);
  $('#btnDm').onclick = () => KC.setSetting('danmaku', !KC.settings.danmaku);
  KC.onSetting(syncSettingsUI);

  $('#soundTest').onclick = () => {
    KC.audio.unlock();
    if (!KC.audio.available()) return toast('Звуки пока не добавлены: положите файлы в public/sounds');
    if (!KC.audio.test()) toast(KC.settings.sound ? 'Звук ещё загружается или заблокирован браузером' : 'Звуки выключены');
  };
  function updateAudioUI() {
    const need = KC.settings.sound && KC.audio.available() && !KC.audio.running();
    $('#audioHint').hidden = !need;
    $('#soundHint').textContent = KC.audio.available()
      ? `Загружено звуков: ${KC.audio.buffers.size} из ${Object.keys(KC.audio.defs).length}`
      : 'Звуки пока не добавлены. Подробности в public/sounds/README.txt';
    KC.emoji.refresh();
  }
  $('#audioHint').onclick = () => KC.audio.unlock();
  KC.audio.onChange(updateAudioUI);

  /* ---------- полный экран ---------- */
  // Во весь экран уходит весь блок (видео + слои + панель), поэтому комментарии и реакции остаются на месте
  function setPseudoFs(on) {
    $('#stageWrap').classList.toggle('pseudo-fs', on);
    document.body.classList.toggle('has-pseudo-fs', on);
    updateFsBtn();
  }
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  function updateFsBtn() {
    const on = !!fsEl() || $('#stageWrap').classList.contains('pseudo-fs');
    $('#btnFs').textContent = on ? '🗗' : '⛶';
    $('#btnFs').title = on ? 'Выйти из полного экрана' : 'Полный экран';
  }
  $('#btnFs').onclick = () => {
    const wrap = $('#stageWrap');
    if (fsEl()) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    if (wrap.classList.contains('pseudo-fs')) return setPseudoFs(false);
    const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (!req) return setPseudoFs(true);
    Promise.resolve(req.call(wrap)).catch(() => setPseudoFs(true));
  };
  document.addEventListener('fullscreenchange', updateFsBtn);
  document.addEventListener('webkitfullscreenchange', updateFsBtn);

  /* ---------- профиль и аватарка ---------- */
  let draft = null;
  const MAX_AVATAR_BYTES = 28 * 1024;
  function renderProfile() {
    const name = $('#profName').value.trim() || profile.name || 'Гость';
    $('#profPreview').replaceChildren(localAvatar(draft, name));
    const grid = $('#profGrid');
    grid.replaceChildren(...Array.from({ length: KC.AVATAR_PRESETS }, (_, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Аватарка ' + (i + 1));
      b.className = draft.p === i ? 'on' : '';
      b.appendChild(KC.avatarEl({ name, av: 'p' + i }));
      b.onclick = () => { draft = { p: i }; renderProfile(); };
      return b;
    }));
  }
  function openProfile() {
    draft = { ...profile.avatar };
    $('#profName').value = profile.name;
    renderProfile();
    $('#profile').hidden = false;
    $('#profName').focus();
  }
  $('#meBtn').onclick = openProfile;
  $('#landingAvaBtn').onclick = () => { $('#profName').value = $('#nameInput').value.trim(); openProfile(); $('#profName').value = $('#nameInput').value.trim(); };
  $('#profName').addEventListener('input', renderProfile);
  $('#profCancel').onclick = () => { $('#profile').hidden = true; };
  $('#profile').addEventListener('pointerdown', (e) => { if (e.target === $('#profile')) $('#profile').hidden = true; });

  // Картинка -> квадрат 96x96 -> WebP/JPEG до ~28 КБ. Исходный файл на сервер не уходит.
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) throw new Error('empty');
      for (const px of [96, 72]) {
        const c = document.createElement('canvas');
        c.width = c.height = px;
        c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, px, px);
        for (const [type, q] of [['image/webp', 0.85], ['image/webp', 0.65], ['image/jpeg', 0.8], ['image/jpeg', 0.6], ['image/jpeg', 0.4]]) {
          const blob = await new Promise((r) => c.toBlob(r, type, q));
          if (blob && blob.type === type && blob.size <= MAX_AVATAR_BYTES) return blob;
        }
      }
      throw new Error('big');
    } finally { URL.revokeObjectURL(url); }
  }
  $('#profFile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) return toast('Нужна картинка PNG, JPEG, WebP или GIF');
    if (f.size > 5 * 1024 * 1024) return toast('Файл больше 5 МБ');
    try {
      const blob = await shrink(f);
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      draft = { data: String(dataUrl).split(',')[1], mime: blob.type };
      renderProfile();
    } catch { toast('Не удалось обработать картинку. Попробуйте другую'); }
  };
  $('#profSave').onclick = () => {
    const name = $('#profName').value.trim();
    if (!name) { $('#profName').focus(); return toast('Введите имя'); }
    profile.name = name;
    profile.avatar = draft;
    myName = name;
    try { localStorage.setItem('kc_name', name); } catch {}
    KC.store.set('kc_avatar', draft);
    $('#nameInput').value = name;
    renderMine();
    $('#profile').hidden = true;
    if (inRoom) send({ type: 'profile', name, avatar: avatarForServer() });
  };

  /* ---------- прочее ---------- */
  $('#copyBtn').onclick = async () => {
    const url = location.origin + location.pathname + '?room=' + roomCode;
    try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована. Отправьте её друзьям'); }
    catch { prompt('Скопируйте ссылку:', url); }
  };

  /* ---------- запуск ---------- */
  renderMine();
  paintColor();
  syncSettingsUI();
  KC.danmaku.init($('#dm'));
  KC.onSetting((k, v) => { if (k === 'reactions' && !v) $('#floaty').replaceChildren(); });
  KC.audio.load();
  KC.emoji.load().then(() => KC.emoji.mount($('#emojiPop'), sendReaction)).catch(() => toast('Не удалось загрузить список эмодзи'));
})();
