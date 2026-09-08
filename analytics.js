/* ============================================================================
   ЖУРНАЛ АКТИВНОСТІ ПОРТАЛУ
   Збирає події й характеристики візиту та відправляє пакетом на бекенд
   (requestType: 'log_activity'). Пише у вкладки «Логи» і «Візити».

   Правила, яких цей файл дотримується:
     • Працює лише для авторизованого працівника — без сесії не шле нічого.
     • Будь-яка помилка тут не має ламати сторінку: усе в try/catch.
     • Дані йдуть пакетами (раз на 30 с, при згортанні вкладки й при закритті),
       а не на кожен клік — бекенд читає таблицю сесій на кожен запит.
     • IP і геолокацію не збираємо: Apps Script не бачить IP, а тягнути його
       зі стороннього сервісу означає віддати туди адреси працівників,
       до того ж таке значення легко підробити з консолі.
   ========================================================================== */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbzYLX7Rc3jfg1zH_DW_Qbx3uiAK38T9aojJiCwVKSX2-3zej4ScsuC9aFeKcYMNcVfzVA/exec';
  var FLUSH_MS   = 30000;   // як часто відправляти накопичене
  var IDLE_MS    = 30000;   // без дій довше цього — час не рахується активним
  var MAX_BUFFER = 60;      // більше подій за раз не тримаємо

  var buf = [], env = null, started = false;
  var sid = '', visit = 0, firstVisit = '';
  var t0 = Date.now(), activeMs = 0, lastTick = Date.now(), lastInput = Date.now();
  var maxScroll = 0, eventsTotal = 0, keyAction = '';

  function ls(k)      { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k,v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ss(k)      { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k,v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  function uuid() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // ---- розбір User-Agent ----
  function parseUA(ua) {
    var r = { device: 'ПК', browser: '', browserVersion: '', os: '', osVersion: '' };
    if (/iPad|Tablet/i.test(ua)) r.device = 'Планшет';
    else if (/Mobi|Android|iPhone/i.test(ua)) r.device = 'Телефон';

    var b = [['Edg', 'Edge'], ['OPR', 'Opera'], ['SamsungBrowser', 'Samsung Internet'],
             ['Firefox', 'Firefox'], ['Chrome', 'Chrome'], ['Safari', 'Safari']];
    for (var i = 0; i < b.length; i++) {
      var m = ua.match(new RegExp(b[i][0] + '\\/([0-9.]+)'));
      if (m) { r.browser = b[i][1]; r.browserVersion = m[1]; break; }
    }
    var os = [[/Windows NT ([0-9._]+)/, 'Windows'], [/Android ([0-9._]+)/, 'Android'],
              [/iPhone OS ([0-9_]+)/, 'iOS'], [/CPU OS ([0-9_]+)/, 'iPadOS'],
              [/Mac OS X ([0-9_.]+)/, 'macOS'], [/(Linux)/, 'Linux']];
    for (var j = 0; j < os.length; j++) {
      var mm = ua.match(os[j][0]);
      if (mm) { r.os = os[j][1]; r.osVersion = (mm[1] || '').replace(/_/g, '.'); break; }
    }
    return r;
  }

  function yesNo(v) { return v ? 'так' : 'ні'; }

  function collectEnv() {
    var ua = navigator.userAgent || '';
    var p = parseUA(ua);
    var nav = navigator.connection || {};
    var e = {
      path: location.pathname.split('/').pop() || 'index.html',
      referrer: document.referrer || '',
      device: p.device, browser: p.browser, browserVersion: p.browserVersion,
      os: p.os, osVersion: p.osVersion, model: '', arch: '',
      screen: (screen.width || '') + '×' + (screen.height || ''),
      window: (window.innerWidth || '') + '×' + (window.innerHeight || ''),
      dpr: window.devicePixelRatio || '',
      colorDepth: screen.colorDepth || '',
      touch: yesNo('ontouchstart' in window || navigator.maxTouchPoints > 0),
      cpuCores: navigator.hardwareConcurrency || '',
      memoryGb: navigator.deviceMemory || '',
      connType: nav.effectiveType || '', downlink: nav.downlink || '', rtt: nav.rtt || '',
      saveData: nav.saveData === undefined ? '' : yesNo(nav.saveData),
      lang: navigator.language || '',
      langs: (navigator.languages || []).join(', '),
      tz: '', tzOffset: -new Date().getTimezoneOffset() / 60,
      darkTheme: '', reducedMotion: '',
      cookies: yesNo(navigator.cookieEnabled),
      dnt: (navigator.doNotTrack === '1' || window.doNotTrack === '1') ? 'так' : 'ні',
      ttfb: '', domMs: '', loadMs: '',
      firstVisit: firstVisit, ua: ua
    };
    try { e.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (x) {}
    try {
      e.darkTheme     = yesNo(matchMedia('(prefers-color-scheme: dark)').matches);
      e.reducedMotion = yesNo(matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (x) {}
    try {
      var nt = performance.getEntriesByType('navigation')[0];
      if (nt) {
        e.ttfb   = Math.round(nt.responseStart);
        e.domMs  = Math.round(nt.domContentLoadedEventEnd);
        e.loadMs = Math.round(nt.loadEventEnd || nt.duration);
      }
    } catch (x) {}
    // Модель пристрою й архітектура доступні лише через Client Hints (Chrome).
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        navigator.userAgentData.getHighEntropyValues(['model', 'architecture', 'platformVersion'])
          .then(function (h) {
            e.model = h.model || '';
            e.arch  = h.architecture || '';
            if (h.platformVersion && !e.osVersion) e.osVersion = h.platformVersion;
          }).catch(function () {});
      }
    } catch (x) {}
    return e;
  }

  // ---- активний час ----
  function tick() {
    var now = Date.now();
    if (document.visibilityState === 'visible' && (now - lastInput) < IDLE_MS) {
      activeMs += now - lastTick;
    }
    lastTick = now;
  }
  function markInput() { lastInput = Date.now(); }

  function trackScroll() {
    try {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      var pct = h > 0 ? Math.round((window.scrollY / h) * 100) : 100;
      if (pct > maxScroll) maxScroll = Math.min(100, pct);
    } catch (e) {}
  }

  /** Записати подію. details — обʼєкт або рядок. key=true робить її «ключовою дією» візиту. */
  function log(event, details, key) {
    if (!started) return;
    eventsTotal++;
    if (key) keyAction = event + (details && details.name ? ': ' + details.name : '');
    if (buf.length >= MAX_BUFFER) buf.shift();
    buf.push({
      t: new Date().toISOString(),
      sec: Math.round((Date.now() - t0) / 1000),
      event: String(event || ''),
      details: details === undefined ? '' : details
    });
  }

  function payload() {
    tick();
    return {
      requestType: 'log_activity',
      token: ss('portal_token') || '',
      sid: sid, visit: visit,
      durationSec: Math.round((Date.now() - t0) / 1000),
      activeSec: Math.round(activeMs / 1000),
      eventsTotal: eventsTotal,
      scrollPct: maxScroll,
      keyAction: keyAction,
      env: env,
      events: buf.splice(0, buf.length)
    };
  }

  function flush(useBeacon) {
    if (!started) return;
    var body = JSON.stringify(payload());
    try {
      if (useBeacon && navigator.sendBeacon) {
        // text/plain — щоб запит лишався «простим» і не потребував preflight,
        // якого Apps Script не обслуговує.
        navigator.sendBeacon(API, new Blob([body], { type: 'text/plain;charset=utf-8' }));
        return;
      }
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  function start() {
    if (started) return;
    var user = ss('portal_user'), token = ss('portal_token');
    if (!user || !token) return;

    sid = ss('portal_sid');
    if (!sid) { sid = uuid(); ssSet('portal_sid', sid); }

    firstVisit = ls('portal_first_visit');
    if (!firstVisit) { firstVisit = new Date().toISOString(); lsSet('portal_first_visit', firstVisit); }

    visit = parseInt(ls('portal_visit_no') || '0', 10);
    if (!ss('portal_visit_counted')) {
      visit += 1;
      lsSet('portal_visit_no', String(visit));
      ssSet('portal_visit_counted', '1');
    }

    env = collectEnv();
    started = true;

    log('Відкрив сторінку', { сторінка: env.path }, true);

    ['click', 'keydown', 'touchstart', 'mousemove', 'scroll'].forEach(function (t) {
      window.addEventListener(t, markInput, { passive: true });
    });
    window.addEventListener('scroll', trackScroll, { passive: true });
    setInterval(tick, 5000);
    setInterval(function () { if (buf.length) flush(false); }, FLUSH_MS);

    // Клік по кнопці/посиланню з текстом — щоб було видно шлях працівника.
    document.addEventListener('click', function (ev) {
      try {
        var el = ev.target.closest('a, button, [data-log]');
        if (!el) return;
        // textContent порожній у кнопок з однією іконкою — тоді беремо підпис.
        var name = (el.getAttribute('data-log') || el.getAttribute('aria-label') ||
                    el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (!name) return;
        log('Натиснув', { name: name.slice(0, 80) }, true);
      } catch (e) {}
    }, true);

    document.addEventListener('visibilitychange', function () {
      tick();
      if (document.visibilityState === 'hidden') { log('Згорнув вкладку'); flush(true); }
      else { lastInput = Date.now(); log('Повернувся'); }
    });
    window.addEventListener('pagehide', function () { log('Пішов зі сторінки'); flush(true); });

    window.portalLog = log;   // щоб сторінки могли писати свої події
  }

  // На index.html працівник ще не авторизований — чекаємо появи сесії.
  function boot() {
    start();
    if (started) return;
    var tries = 0;
    var iv = setInterval(function () {
      start();
      if (started || ++tries > 300) clearInterval(iv);   // максимум 10 хвилин очікування
    }, 2000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
