/* =========================================================
   Birdie Tickets – Einlass-Scanner (einlass.js)
   Eigenständige, abgespeckte Seite: Login nur per Einlass-
   Passwort (pro Ball), danach ausschließlich QR-Check-in.
   Kein Zugriff auf Umsätze, Bestellungen oder Einstellungen.

   OFFLINE-FÄHIG:
   - Nach dem Login wird die Liste aller gültigen Tickets aufs
     Gerät geladen (localStorage) und regelmäßig aktualisiert.
   - Ohne Internet prüft der Scanner gegen diese Liste, merkt
     sich die Check-ins und überträgt sie automatisch, sobald
     wieder Verbindung besteht (inkl. Konfliktmeldung).
   - Die Seite selbst wird per Service Worker (einlass-sw.js)
     gespeichert und lädt auch ohne Netz.
   ========================================================= */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const S = window.CMStore;

  function msg(el, text, type) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (type ? ' ' + type : '') + (text ? ' show' : '');
  }
  const hhmm = d => new Date(d).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });

  const params = new URLSearchParams(location.search);
  const eventId = params.get('event');
  let pw = '';            // Einlass-Passwort
  let eventName = '';
  let loggedIn = false;
  let serverDown = false;  // Internet laut Gerät da, aber Server nicht erreichbar
  const PKEY = 'bt_einlass_pw_' + (eventId || '');      // Passwort (für Abgleich im Hintergrund)
  const OKEY = 'bt_einlass_data_' + (eventId || '');    // Offline-Ticketliste + Warteschlange
  const OLD_SKEY = 'cm_einlass_' + (eventId || '');

  /* ---------------- Hilfen: Zeitlimit & Speicher ---------------- */
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => {
      const e = new Error('Zeitüberschreitung – keine Verbindung.'); e.offline = true; rej(e);
    }, ms))]);
  }
  async function sha(text) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (_) { return 'x' + text.length + ':' + btoa(unescape(encodeURIComponent(text))).slice(-12); }
  }
  let data = null;   // { event, listAt, pwHash, tickets:{CODE:{c,s,n,e,ci,at}}, queue:[{code,at}] }
  function loadData() {
    try { data = JSON.parse(localStorage.getItem(OKEY) || 'null'); } catch (_) { data = null; }
    if (data && !Array.isArray(data.queue)) data.queue = [];
  }
  function saveData() {
    try { localStorage.setItem(OKEY, JSON.stringify(data)); }
    catch (e) { msg($('scanMsg'), 'Achtung: Gerätespeicher voll – Offline-Liste konnte nicht gespeichert werden.', 'error'); }
  }

  /* ---------------- Login ---------------- */
  async function tryLogin(password, silent) {
    let res = null, offline = false;
    try { res = await withTimeout(S.verifyCheckinPassword(eventId, password), 7000); }
    catch (e) { if (e.offline) offline = true; else throw e; }
    serverDown = offline;

    if (offline) {
      // Ohne Internet: nur möglich, wenn dieses Gerät schon einmal online angemeldet war.
      loadData();
      const h = await sha(eventId + '|' + password);
      if (!data || !data.pwHash) throw new Error('Keine Internetverbindung. Der Offline-Einlass ist erst möglich, nachdem sich dieses Gerät einmal online angemeldet hat.');
      if (data.pwHash !== h) throw new Error('Falsches Passwort (Offline-Prüfung).');
      eventName = data.event || 'Einlass';
    } else {
      if (!res || !res.ok) {
        if (res && res.reason === 'disabled') throw new Error('Für diesen Ball ist der Einlass-Scanner nicht aktiviert.');
        throw new Error('Falsches Passwort.');
      }
      eventName = res.event || 'Einlass';
      loadData();
      const h = await sha(eventId + '|' + password);
      if (!data || data.pwHash !== h) {
        // Neues Passwort/erstes Login: alte Daten nur verwerfen, wenn nichts mehr zu übertragen ist.
        if (data && data.queue && data.queue.length) { data.pwHash = h; }
        else data = { event: eventName, listAt: null, pwHash: h, tickets: {}, queue: [] };
      }
      data.event = eventName;
      saveData();
    }
    pw = password;
    loggedIn = true;
    try { localStorage.setItem(PKEY, password); sessionStorage.removeItem(OLD_SKEY); } catch (e) {}
    $('ciGate').style.display = 'none';
    $('ciScan').style.display = '';
    $('ciScanEvent').textContent = eventName;
    $('ciEventName').textContent = eventName;
    $('ciEventName').style.display = '';
    $('ciLogout').style.display = '';
    renderStatus();
    if (!offline) {
      refreshList(true).then(syncQueue);
      if (!silent) msg($('scanMsg'), 'Angemeldet. Ticketliste wird für den Offline-Einlass geladen …', 'ok');
    } else if (!silent) {
      msg($('scanMsg'), 'Offline angemeldet – es wird gegen die gespeicherte Ticketliste geprüft.', 'info');
    }
  }

  function logout() {
    const pending = data && data.queue ? data.queue.length : 0;
    if (pending && !confirm(pending + ' Check-in(s) wurden noch nicht übertragen (kein Internet).\n\n' +
        'Bitte zuerst wieder online gehen und warten, bis „0 ausstehend“ angezeigt wird.\n\nTrotzdem abmelden? Die ausstehenden Check-ins bleiben auf diesem Gerät gespeichert.')) return;
    try {
      localStorage.removeItem(PKEY);
      sessionStorage.removeItem(OLD_SKEY);
      if (!pending) localStorage.removeItem(OKEY);
    } catch (e) {}
    pw = ''; loggedIn = false;
    scanStop();
    location.reload();
  }

  /* ---------------- Offline-Ticketliste ---------------- */
  let refreshing = false;
  async function refreshList(showMsg) {
    if (!loggedIn || refreshing || !navigator.onLine) return false;
    refreshing = true;
    try {
      const r = await withTimeout(S.checkinTicketList(eventId, pw), 25000);
      const queued = new Map((data.queue || []).map(q => [q.code, q.at]));
      const map = {};
      (r.tickets || []).forEach(t => {
        map[t.code] = { c: t.category || '', s: t.seat || '', n: t.name || '', e: t.email || '',
          ci: !!t.checked_in, at: t.checked_in_at || null };
        if (queued.has(t.code) && !map[t.code].ci) { map[t.code].ci = true; map[t.code].at = queued.get(t.code); }
      });
      data.tickets = map;
      serverDown = false;
      data.listAt = r.generated_at || new Date().toISOString();
      if (r.event) data.event = r.event;
      saveData();
      if (showMsg) msg($('scanMsg'), '✓ Ticketliste gespeichert (' + Object.keys(map).length + ' Tickets) – Scanner funktioniert jetzt auch ohne Internet.', 'ok');
      return true;
    } catch (e) {
      if (e.offline) serverDown = true;
      if (showMsg && !e.offline) msg($('scanMsg'), 'Ticketliste konnte nicht geladen werden: ' + e.message, 'error');
      return false;
    } finally { refreshing = false; renderStatus(); }
  }

  /* ---------------- Abgleich offline gescannter Check-ins ---------------- */
  let syncing = false;
  async function syncQueue() {
    if (!loggedIn || syncing || !data || !data.queue || !data.queue.length || !navigator.onLine) return;
    syncing = true; renderStatus();
    try {
      netDownUntil = 0;
      const batch = data.queue.slice(0, 200);
      const res = await withTimeout(S.checkinSyncOffline(eventId, pw, batch), 20000);
      const byCode = {}; (res || []).forEach(x => { byCode[x.code] = x; });
      const done = new Set();
      batch.forEach(q => {
        const r = byCode[q.code];
        if (!r) return;
        done.add(q.code);
        if (r.status === 'already') {
          const diff = r.checked_in_at ? Math.abs(new Date(r.checked_in_at) - new Date(q.at)) : 0;
          if (diff > 120000) pushLog(false, '⚠ ' + q.code + ' war bereits um ' + hhmm(r.checked_in_at) + ' an einem anderen Gerät eingecheckt (offline-Scan um ' + hhmm(q.at) + ') – mögliche Doppelnutzung.');
        } else if (r.status === 'invalid' || r.status === 'unknown') {
          pushLog(false, '⚠ ' + q.code + ' (offline eingelassen) ist laut Server ungültig' + (r.order_status ? ' – Bestellung ' + r.order_status : '') + '.');
        }
      });
      data.queue = data.queue.filter(q => !done.has(q.code));
      serverDown = false;
      saveData();
    } catch (e) { if (e.offline) serverDown = true; /* bleibt in der Warteschlange – nächster Versuch automatisch */ }
    finally { syncing = false; renderStatus(); }
  }

  /* ---------------- Statusanzeige ---------------- */
  function renderStatus() {
    const box = $('ciNet');
    if (!box || !loggedIn) return;
    const online = navigator.onLine && !serverDown;
    const tickets = data && data.tickets ? Object.values(data.tickets) : [];
    const inside = tickets.filter(t => t.ci).length;
    const pending = data && data.queue ? data.queue.length : 0;
    const hasList = !!(data && data.listAt);
    $('ciNetDot').style.background = !online ? '#e5a13a' : (hasList ? '#4caf50' : '#e5a13a');
    $('ciNetTitle').textContent = online
      ? (hasList ? 'Online · Offline-Einlass bereit' : 'Online · Ticketliste wird geladen …')
      : 'OFFLINE-MODUS · Scans werden auf dem Gerät gespeichert';
    $('ciNetInfo').textContent =
      (hasList ? tickets.length + ' Tickets gespeichert (Stand ' + hhmm(data.listAt) + ') · Eingecheckt: ' + inside + ' / ' + tickets.length
               : 'Noch keine Ticketliste auf diesem Gerät') +
      ' · ' + (pending ? pending + ' Check-in(s) noch nicht übertragen' + (syncing ? ' (wird übertragen …)' : '') : 'alles übertragen');
    $('ciNetInfo').style.color = pending ? '#e5a13a' : '';
    box.style.borderColor = online ? '' : '#e5a13a';
  }

  /* ---------------- Check-in-Kern ---------------- */
  const logEntries = [];
  function pushLog(ok, text) {
    logEntries.unshift({ ok, text, at: new Date() });
    $('ciLog').innerHTML = logEntries.slice(0, 40).map(e =>
      '<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.06)">' +
      '<span style="color:' + (e.ok ? 'var(--gold-light)' : '#e57373') + '">' + (e.ok ? '✓' : '✕') + '</span>' +
      '<span style="flex:1">' + text2html(e.text) + '</span>' +
      '<span class="hint">' + e.at.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</span>' +
      '</div>').join('');
  }
  function text2html(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function localInfo(code, t) {
    return code + ' – ' + (t.c || 'Ticket') + (t.s ? ' · ' + t.s : '') + (t.n || t.e ? ' (' + (t.n || t.e) + ')' : '');
  }

  function offlineCheckin(code, targetMsg) {
    if (!data || !data.listAt) {
      msg(targetMsg, 'Keine Internetverbindung und noch keine Ticketliste auf diesem Gerät – Ticket kann nicht geprüft werden.', 'error');
      pushLog(false, code + ' – offline, keine Ticketliste');
      return false;
    }
    const t = data.tickets[code];
    if (!t) {
      msg(targetMsg, '✕ ' + code + ': nicht in der Ticketliste (Stand ' + hhmm(data.listAt) + ') – ungültig, storniert oder erst danach gekauft.', 'error');
      pushLog(false, code + ' – nicht in der Offline-Liste');
      return false;
    }
    if (t.ci) {
      msg(targetMsg, '✕ ' + code + ': bereits eingecheckt' + (t.at ? ' (' + hhmm(t.at) + ')' : '') + '.', 'error');
      pushLog(false, code + ' – bereits eingecheckt' + (t.at ? ' (' + hhmm(t.at) + ')' : ''));
      return false;
    }
    const at = new Date().toISOString();
    t.ci = true; t.at = at;
    data.queue.push({ code, at });
    saveData();
    const info = localInfo(code, t);
    msg(targetMsg, '✓ Eingecheckt (offline): ' + info, 'ok');
    pushLog(true, info + ' · offline');
    renderStatus();
    return true;
  }

  // Nach einem Netzwerkfehler 20 s direkt offline prüfen (kein 5-s-Warten bei jedem Scan)
  let netDownUntil = 0;
  async function doCheckin(raw, targetMsg) {
    const code = S.extractCode(raw);
    if (!code) return false;
    if (navigator.onLine && Date.now() > netDownUntil) {
      try {
        const r = await withTimeout(S.checkInWithPassword(eventId, pw, code), 5000);
        const info = r.code + ' – ' + r.category + (r.seat ? ' · ' + r.seat : '') + ' (' + r.email + ')';
        serverDown = false;
        if (data && data.tickets && data.tickets[r.code]) { data.tickets[r.code].ci = true; data.tickets[r.code].at = new Date().toISOString(); saveData(); renderStatus(); }
        msg(targetMsg, '✓ Eingecheckt: ' + info, 'ok');
        pushLog(true, info);
        return true;
      } catch (e) {
        if (!e.offline) {
          if (/bereits eingecheckt/i.test(e.message) && data && data.tickets && data.tickets[code] && !data.tickets[code].ci) {
            data.tickets[code].ci = true; saveData(); renderStatus();
          }
          msg(targetMsg, code + ': ' + e.message, 'error');
          pushLog(false, code + ' – ' + e.message);
          return false;
        }
        // Netzwerkproblem → Offline-Prüfung
        netDownUntil = Date.now() + 20000;
        serverDown = true;
      }
    }
    renderStatus();
    return offlineCheckin(code, targetMsg);
  }

  /* ---------------- QR-Scanner (Kamera + Foto) ---------------- */
  let scanStream = null, scanTimer = null, scanStart0 = 0;
  let lastScan = { code: '', at: 0 };
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

  function decode(source, sw, sh) {
    if (!window.jsQR) return null;
    const maxW = 1000;
    const scale = sw > maxW ? maxW / sw : 1;
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    scanCanvas.width = w; scanCanvas.height = h;
    scanCtx.drawImage(source, 0, 0, w, h);
    const img = scanCtx.getImageData(0, 0, w, h);
    const hit = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    return hit && hit.data ? hit.data : null;
  }

  async function scanHit(text) {
    const code = S.extractCode(text);
    const now = Date.now();
    if (code === lastScan.code && now - lastScan.at < 4000) return; // Entprellen
    lastScan = { code, at: now };
    const frame = $('scanFrame');
    const ok = await doCheckin(code, $('scanMsg'));
    if (frame) { frame.style.borderColor = ok ? '#4caf50' : '#e53935'; setTimeout(() => { frame.style.borderColor = ''; }, 800); }
    try { if (navigator.vibrate) navigator.vibrate(ok ? 80 : [60, 60, 60]); } catch (_) {}
  }

  async function scanStart() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg($('scanMsg'), 'Dieser Browser unterstützt keinen Live-Kamerazugriff (HTTPS erforderlich). Nutze „Foto scannen“.', 'error'); return;
    }
    if (!window.jsQR) { msg($('scanMsg'), 'Scanner-Bibliothek nicht geladen – bitte Seite neu laden.', 'error'); return; }
    try {
      msg($('scanMsg'), 'Kamera wird gestartet …', 'info');
      try {
        scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        scanStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      const video = $('scanVideo');
      video.srcObject = scanStream;
      await video.play().catch(() => {});
      $('scannerBox').style.display = '';
      $('btnScanStart').style.display = 'none';
      $('btnScanStop').style.display = '';
      msg($('scanMsg'), 'Scanner aktiv – QR-Code formatfüllend und ruhig ins Bild halten.', 'info');
      scanStart0 = Date.now();
      const loop = async () => {
        if (!scanStream) return;
        const video = $('scanVideo');
        if (video.readyState >= 2 && video.videoWidth) {
          const code = decode(video, video.videoWidth, video.videoHeight);
          if (code) { await scanHit(code); }
          else if (Date.now() - scanStart0 > 8000 && !/eingecheckt|bereits|nicht|falsch|offline/i.test($('scanMsg').textContent)) {
            msg($('scanMsg'), 'Noch nichts erkannt: näher heran/scharfstellen, mehr Licht – oder „Foto scannen“ nutzen.', 'info');
          }
        }
        scanTimer = setTimeout(() => requestAnimationFrame(loop), 120);
      };
      requestAnimationFrame(loop);
    } catch (e) {
      msg($('scanMsg'), 'Kamera nicht verfügbar: ' + e.message + ' – nutze „Foto scannen“.', 'error');
      scanStop();
    }
  }

  function scanStop() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    const box = $('scannerBox'); if (box) box.style.display = 'none';
    if ($('btnScanStart')) $('btnScanStart').style.display = '';
    if ($('btnScanStop')) $('btnScanStop').style.display = 'none';
  }

  async function scanPhoto(file) {
    if (!file) return;
    if (!window.jsQR) { msg($('scanMsg'), 'Scanner-Bibliothek nicht geladen – bitte Seite neu laden.', 'error'); return; }
    msg($('scanMsg'), 'Foto wird ausgewertet …', 'info');
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const code = decode(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
      if (!code) { msg($('scanMsg'), 'Kein QR-Code im Foto erkannt – bitte näher/schärfer fotografieren.', 'error'); return; }
      await scanHit(code);
    } catch (e) {
      msg($('scanMsg'), 'Foto konnte nicht ausgewertet werden: ' + e.message, 'error');
    }
  }

  /* ---------------- Seite offline verfügbar machen (Service Worker) ---------------- */
  function registerOffline() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('einlass-sw.js', { scope: './einlass' }).then(() => navigator.serviceWorker.ready).then(reg => {
      // Alle Dateien, die diese Seite gerade geladen hat, für den Offline-Fall speichern.
      const urls = [location.href].concat(performance.getEntriesByType('resource').map(r => r.name))
        .filter(u => u.startsWith(location.origin) || /fonts\.(googleapis|gstatic)\.com/.test(u));
      if (reg.active) reg.active.postMessage({ type: 'cache', urls });
    }).catch(() => {});
  }

  /* ---------------- Start ---------------- */
  async function boot() {
    await S.init();
    if (!eventId) {
      $('ciGateForm').style.display = 'none';
      msg($('ciGateErr'), 'Ungültiger Einlass-Link – es fehlt die Ball-Kennung. Bitte den Link von der Ball-Leitung erneut anfordern.', 'error');
      return;
    }
    registerOffline();
    // Bereits auf diesem Gerät angemeldet?
    let saved = '';
    try { saved = localStorage.getItem(PKEY) || sessionStorage.getItem(OLD_SKEY) || ''; } catch (e) {}
    if (saved) {
      try { await tryLogin(saved, true); }
      catch (e) { try { localStorage.removeItem(PKEY); sessionStorage.removeItem(OLD_SKEY); } catch (_) {} msg($('ciGateMsg'), e.message, 'error'); }
    }

    $('btnCiLogin').addEventListener('click', async () => {
      const val = $('ciPw').value.trim();
      if (!val) { msg($('ciGateMsg'), 'Bitte das Passwort eingeben.', 'error'); return; }
      $('btnCiLogin').disabled = true;
      try { await tryLogin(val, false); }
      catch (e) { msg($('ciGateMsg'), e.message, 'error'); }
      finally { $('btnCiLogin').disabled = false; }
    });
    $('ciPw').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnCiLogin').click(); });
    $('ciLogout').addEventListener('click', e => { e.preventDefault(); logout(); });

    $('btnScanStart').addEventListener('click', scanStart);
    $('btnScanStop').addEventListener('click', scanStop);
    $('btnScanPhoto').addEventListener('click', () => $('scanPhoto').click());
    $('scanPhoto').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; scanPhoto(f); });
    $('btnCiCheck').addEventListener('click', async () => {
      const code = $('ciCode').value.trim();
      if (!code) { msg($('ciCodeMsg'), 'Bitte einen Ticketcode eingeben.', 'error'); return; }
      const ok = await doCheckin(code, $('ciCodeMsg'));
      if (ok) $('ciCode').value = '';
    });
    $('ciCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnCiCheck').click(); });
    if ($('btnCiRefresh')) $('btnCiRefresh').addEventListener('click', async () => {
      if (!navigator.onLine) { msg($('scanMsg'), 'Keine Internetverbindung – die gespeicherte Liste wird weiter verwendet.', 'info'); return; }
      await syncQueue();
      await refreshList(true);
    });

    // Netz kommt zurück → sofort abgleichen; regelmäßig Liste aktualisieren
    window.addEventListener('online', () => { renderStatus(); syncQueue().then(() => refreshList(false)); });
    window.addEventListener('offline', renderStatus);
    setInterval(syncQueue, 15000);
    setInterval(() => refreshList(false), 90000);
    // Vor dem Schließen warnen, solange noch Check-ins ausstehen
    window.addEventListener('beforeunload', e => {
      if (data && data.queue && data.queue.length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  boot().catch(e => { msg($('ciGateErr'), 'Fehler beim Laden: ' + e.message, 'error'); });
})();
