'use strict';
// Панель эмодзи: категории, поиск, недавние. Отправку и звуки решает приложение (onPick).
(function () {
  const KC = window.KC;
  const E = (KC.emoji = { data: null });
  const RECENT_KEY = 'kc_recent';
  let cats = [], activeCat = 'recent', query = '', onPick = () => {};
  let grid, search, tabs, title;

  const recent = () => KC.store.get(RECENT_KEY, []).filter((e) => typeof e === 'string').slice(0, 24);
  E.remember = (emoji) => KC.store.set(RECENT_KEY, [emoji, ...recent().filter((e) => e !== emoji)].slice(0, 24));

  function items() {
    if (query) {
      const q = query.toLowerCase();
      const out = [];
      for (const c of E.data.categories) for (const [e, kw] of c.items) if (kw.toLowerCase().includes(q) || e === q) out.push(e);
      return out;
    }
    if (activeCat === 'recent') return recent();
    const c = E.data.categories.find((x) => x.id === activeCat);
    return c ? c.items.map((i) => i[0]) : [];
  }

  function renderGrid() {
    const list = items();
    const frag = document.createDocumentFragment();
    for (const e of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.dataset.e = e;
      if (KC.audio.hasSound(e)) b.className = 'snd';
      frag.appendChild(b);
    }
    if (!list.length) {
      const n = document.createElement('div');
      n.className = 'none';
      n.textContent = query ? 'Ничего не найдено' : 'Здесь появятся недавние эмодзи';
      frag.appendChild(n);
    }
    grid.replaceChildren(frag);
    const cur = query ? 'Результаты поиска' : activeCat === 'recent' ? 'Недавние' : (E.data.categories.find((x) => x.id === activeCat) || {}).title;
    title.textContent = cur || '';
  }

  function renderTabs() {
    tabs.replaceChildren(...cats.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.icon;
      b.title = c.title;
      b.setAttribute('aria-label', c.title);
      b.className = c.id === activeCat && !query ? 'on' : '';
      b.onclick = () => { activeCat = c.id; query = ''; search.value = ''; renderTabs(); renderGrid(); };
      return b;
    }));
  }

  E.load = async () => {
    const res = await fetch('/emoji.json');
    E.data = await res.json();
    cats = [{ id: 'recent', icon: '🕘', title: 'Недавние' }, ...E.data.categories];
    if (!recent().length) activeCat = E.data.categories[0].id;
  };

  E.mount = (root, pick) => {
    onPick = pick;
    search = KC.$('#emojiSearch', root);
    tabs = KC.$('.cats', root);
    grid = KC.$('.egrid', root);
    title = KC.$('.etitle', root);
    renderTabs();
    renderGrid();
    search.addEventListener('input', () => { query = search.value.trim(); renderTabs(); renderGrid(); });
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-e]');
      if (b) onPick(b.dataset.e);
    });
  };
  // перерисовать (после загрузки звуков или добавления в недавние)
  E.refresh = () => { if (grid) renderGrid(); };
  E.reset = () => { if (!grid) return; query = ''; search.value = ''; renderTabs(); renderGrid(); };
})();
