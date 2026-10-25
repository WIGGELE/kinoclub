'use strict';
// Проверка: можно ли встроить страницу в iframe на нашем сайте.
// Запуск:  npm run check-embed -- https://tapeop.dev/ваша-ссылка
// Скрипт смотрит только заголовки ответа. Узнать, умеет ли встроенный плеер принимать
// команды play/pause/seek, автоматически нельзя: это зависит от кода внутри страницы.
const target = process.argv[2];
if (!target) { console.error('Укажите ссылку: npm run check-embed -- https://example.com/page'); process.exit(2); }

(async () => {
  let res;
  try { res = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'kinoclub-check/1.0' } }); }
  catch (e) { console.error('Не удалось открыть страницу:', e.message); process.exit(1); }

  const xfo = res.headers.get('x-frame-options');
  const csp = res.headers.get('content-security-policy') || '';
  const fa = /frame-ancestors\s+([^;]*)/i.exec(csp);
  console.log(`Адрес после редиректов: ${res.url}`);
  console.log(`HTTP: ${res.status}`);
  console.log(`X-Frame-Options: ${xfo || 'нет'}`);
  console.log(`CSP frame-ancestors: ${fa ? fa[1].trim() : 'нет'}`);

  const blockedByXfo = xfo && /deny|sameorigin/i.test(xfo);
  const blockedByCsp = fa && !/(^|\s)(\*|https:)(\s|$)/.test(fa[1]);
  if (blockedByXfo || blockedByCsp) {
    console.log('\nВывод: сайт запрещает встраивание в чужие страницы (или разрешает только определённым доменам).');
    console.log('Если frame-ancestors перечисляет домены, нужно, чтобы там был адрес вашего сайта на Render.');
    console.log('Иначе остаётся «Открыть отдельно» + «Старт вместе» (ручная синхронизация без iframe).');
    process.exitCode = 3;
  } else {
    console.log('\nВывод: по заголовкам встраивание не запрещено. Проверьте в браузере, что страница реально показывается.');
    console.log('Синхронизация play/pause/seek будет возможна только если плеер внутри отвечает на postMessage; иначе ручной режим.');
  }
})();
