/* CORE Management Ticketshop – Shop-Logik (tickets.html) */
(function () {
  'use strict';
  const S = window.CMStore;
  const $ = id => document.getElementById(id);

  let cart = {};        // { "eventId|categoryId": qty }
  let EVENTS = [];      // zwischengespeicherte Events
  let SOLD = {};        // verkaufte Stückzahlen je Kategorie
  let SETTINGS = null;
  let pendingEmail = '';
  let afterLogin = null;

  /* ---------- Meldungen / Modals ---------- */
  function msg(el, text, type) {
    el.textContent = text || '';
    el.className = 'msg' + (text ? ' show ' + (type || 'info') : '');
  }
  window.closeModal = id => $(id).classList.remove('open');
  function openModal(id) { $(id).classList.add('open'); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }

  /* ---------- Daten laden ---------- */
  async function loadData() {
    [EVENTS, SOLD, SETTINGS] = await Promise.all([
      S.getEvents(), S.soldByCategory(), S.getSettings()
    ]);
  }

  /* ---------- Navigation / Auth-Status ---------- */
  function renderNav() {
    const user = S.currentUser();
    const a = $('navAuth');
    if (user) {
      a.textContent = user + ' · Abmelden';
      a.onclick = async e => {
        e.preventDefault();
        await S.logout();
        renderNav();
        renderMyTickets();
      };
    } else {
      a.textContent = 'Anmelden';
      a.onclick = e => { e.preventDefault(); openLogin(); };
    }
  }

  /* ---------- Eventliste ---------- */
  function renderEvents() {
    const events = EVENTS.filter(e => e.active);
    const box = $('eventList');
    if (!events.length) {
      box.innerHTML = '<div class="card"><h2>Derzeit keine Tickets im Verkauf</h2>' +
        '<p class="sub">Schau bald wieder vorbei – neue Events werden hier angekündigt.</p></div>';
      return;
    }
    box.innerHTML = events.map(ev => {
      const cats = ev.categories.filter(c => c.active);
      const rows = cats.map(cat => {
        const rest = S.remainingOf(cat, SOLD);
        const key = ev.id + '|' + cat.id;
        const qty = cart[key] || 0;
        const leftCls = rest === 0 ? 'out' : (rest <= 15 ? 'low' : '');
        const leftTxt = rest === 0 ? 'Ausverkauft' : (rest <= 15 ? 'Nur noch ' + rest + ' verfügbar' : rest + ' verfügbar');
        const maxQty = Math.min(rest, cat.maxPerOrder || SETTINGS.maxPerOrder || 10);
        return '<div class="cat-row">' +
          '<div class="cat-info"><div class="name">' + esc(cat.name) + '</div>' +
          (cat.description ? '<div class="desc">' + esc(cat.description) + '</div>' : '') + '</div>' +
          '<div class="cat-price">' + S.fmtEUR.format(cat.price) + '</div>' +
          '<div class="cat-left ' + leftCls + '">' + leftTxt + '</div>' +
          (rest > 0
            ? '<div class="qty">' +
              '<button type="button" data-key="' + key + '" data-d="-1" aria-label="weniger">−</button>' +
              '<input type="text" readonly value="' + qty + '" data-qty="' + key + '">' +
              '<button type="button" data-key="' + key + '" data-d="1" data-max="' + maxQty + '" aria-label="mehr">+</button></div>'
            : '') +
          '</div>';
      }).join('');
      return '<div class="card">' +
        '<div class="event-head"><h2>' + esc(ev.name) + '</h2>' +
        '<span class="event-meta"><b>' + fmtDate(ev.date) + '</b>' +
        (ev.location ? ' · ' + esc(ev.location) : '') + '</span></div>' +
        (ev.description ? '<p class="sub">' + esc(ev.description) + '</p>' : '') +
        rows + '</div>';
    }).join('');

    box.querySelectorAll('.qty button').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const d = parseInt(btn.dataset.d, 10);
        const max = btn.dataset.max ? parseInt(btn.dataset.max, 10) : 99;
        cart[key] = Math.max(0, Math.min(max, (cart[key] || 0) + d));
        if (!cart[key]) delete cart[key];
        box.querySelector('[data-qty="' + key + '"]').value = cart[key] || 0;
        renderCartBar();
      });
    });
  }

  function cartItems() {
    return Object.entries(cart).map(([key, qty]) => {
      const [eventId, categoryId] = key.split('|');
      return { eventId, categoryId, qty };
    }).filter(i => i.qty > 0);
  }

  function cartDetails() {
    let total = 0, count = 0;
    const lines = [];
    cartItems().forEach(i => {
      const ev = EVENTS.find(e => e.id === i.eventId);
      const cat = ev && ev.categories.find(c => c.id === i.categoryId);
      if (!ev || !cat) return;
      total += cat.price * i.qty;
      count += i.qty;
      lines.push({ ev, cat, qty: i.qty, sum: cat.price * i.qty });
    });
    return { total, count, lines };
  }

  function renderCartBar() {
    const { total, count, lines } = cartDetails();
    const bar = $('cartBar');
    if (!count) { bar.classList.remove('visible'); return; }
    bar.classList.add('visible');
    $('cartDesc').textContent = lines.map(l => l.qty + '× ' + l.cat.name).join(' · ');
    $('cartSum').textContent = S.fmtEUR.format(total);
  }

  /* ---------- Login-Flow ---------- */
  window.openLogin = function (cb) {
    afterLogin = typeof cb === 'function' ? cb : null;
    $('loginStep1').style.display = '';
    $('loginStep2').style.display = 'none';
    msg($('loginMsg1'), ''); msg($('loginMsg2'), '');
    openModal('loginModal');
    $('loginEmail').focus();
  };

  window.backToStep1 = function () {
    $('loginStep1').style.display = '';
    $('loginStep2').style.display = 'none';
  };

  async function sendCode(isResend) {
    const email = isResend ? pendingEmail : $('loginEmail').value;
    const m1 = isResend ? $('loginMsg2') : $('loginMsg1');
    try {
      msg(m1, 'Code wird gesendet …', 'info');
      const res = await S.requestCode(email);
      pendingEmail = S.normEmail(email);
      $('loginStep1').style.display = 'none';
      $('loginStep2').style.display = '';
      $('sentInfo').textContent = res.demo
        ? 'Verifizierungscode für ' + pendingEmail + ' erstellt.'
        : 'Wir haben einen Code an ' + pendingEmail + ' gesendet. Bitte auch den Spam-Ordner prüfen.';
      $('demoCodeBox').style.display = res.demo ? '' : 'none';
      if (res.demo) $('demoCode').textContent = res.code;
      msg($('loginMsg2'), '');
      msg($('loginMsg1'), '');
      $('loginCode').value = '';
      $('loginCode').focus();
    } catch (e) {
      msg(m1, e.message, 'error');
    }
  }

  async function verify() {
    try {
      await S.verifyCode(pendingEmail, $('loginCode').value);
      closeModal('loginModal');
      renderNav();
      renderMyTickets();
      if (afterLogin) { const cb = afterLogin; afterLogin = null; cb(); }
    } catch (e) {
      msg($('loginMsg2'), e.message, 'error');
    }
  }

  /* ---------- Checkout ---------- */
  function openCheckout() {
    const user = S.currentUser();
    if (!user) { openLogin(openCheckout); return; }
    const { total, lines } = cartDetails();
    if (!lines.length) return;

    $('checkoutEmail').textContent = 'Bestellung für: ' + user;
    $('checkoutItems').innerHTML = lines.map(l =>
      '<div class="cat-row"><div class="cat-info"><div class="name">' + l.qty + '× ' + esc(l.cat.name) + '</div>' +
      '<div class="desc">' + esc(l.ev.name) + ' · ' + fmtDate(l.ev.date) + '</div></div>' +
      '<div class="cat-price">' + S.fmtEUR.format(l.sum) + '</div></div>').join('');
    $('checkoutTotal').textContent = 'Gesamt: ' + S.fmtEUR.format(total);
    msg($('checkoutMsg'), '');
    $('btnPlaceOrder').disabled = false;

    const onlineRemote = S.remote && SETTINGS.stripeEnabled;
    const onlineLocal = !S.remote && lines.some(l => l.cat.paymentLink);

    if (onlineRemote) {
      $('btnPlaceOrder').textContent = 'Weiter zur Online-Zahlung';
      $('checkoutNote').textContent = 'Du wirst zur sicheren Stripe-Bezahlseite weitergeleitet ' +
        '(Kreditkarte, Apple Pay, Google Pay u. a.). Deine Tickets werden erst nach erfolgreicher Zahlung gültig.';
    } else if (onlineLocal && lines.length > 1) {
      $('checkoutNote').textContent = '';
      $('btnPlaceOrder').disabled = true;
      msg($('checkoutMsg'), 'Online-Zahlung: Bitte bestelle jede Ticketkategorie einzeln – ' +
        'die Zahlung erfolgt pro Kategorie über eine eigene Bezahlseite.', 'error');
    } else if (onlineLocal) {
      $('btnPlaceOrder').textContent = 'Weiter zur Online-Zahlung';
      $('checkoutNote').textContent = 'Du wirst zur sicheren Bezahlseite (Stripe) weitergeleitet. ' +
        'Wichtig: Wähle dort die Menge ' + lines[0].qty + '. ' +
        'Nach erfolgreicher Zahlung kommst du automatisch zurück und deine Tickets werden freigeschaltet.';
    } else {
      $('btnPlaceOrder').textContent = 'Verbindlich bestellen';
      $('checkoutNote').textContent = SETTINGS.checkoutNote;
    }
    openModal('checkoutModal');
  }

  async function placeOrder() {
    const btn = $('btnPlaceOrder');
    try {
      btn.disabled = true;
      btn.textContent = 'Wird verarbeitet …';
      const res = await S.placeOrder(cartItems());
      cart = {};
      closeModal('checkoutModal');
      if (res.checkoutUrl) {
        S.setPendingPayment(res.orderId);
        window.location.href = res.checkoutUrl;
        return;
      }
      await refreshShop();
      const order = res.order || await S.getOrder(res.orderId);
      $('successSub').textContent = 'Bestellnummer ' + res.orderId + ' · ' +
        (order ? order.tickets.length : '') + ' Ticket(s) · ' + S.fmtEUR.format(res.total) +
        ' – deine Tickets sind verbindlich reserviert. Nach Zahlungseingang werden sie ' +
        'freigeschaltet und du kannst sie inkl. QR-Code als PDF herunterladen.';
      $('successTickets').innerHTML = order ? order.tickets.map(t => ticketHTML(t, order)).join('') : '';
      openModal('successModal');
      drawQRCodes($('successTickets'));
    } catch (e) {
      msg($('checkoutMsg'), e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function refreshShop() {
    await loadData();
    renderEvents();
    renderCartBar();
    await renderMyTickets();
  }

  /* ---------- Rückkehr von der Bezahlseite ---------- */
  async function handlePaymentReturn() {
    const params = new URLSearchParams(location.search);
    if (params.get('cancelled') === '1') {
      history.replaceState(null, '', location.pathname + '#meine-tickets');
      return;
    }
    if (params.get('paid') !== '1') return;
    history.replaceState(null, '', location.pathname + location.hash);

    let order = null;
    if (S.remote) {
      const orderId = params.get('order');
      if (!orderId) return;
      // Auf die serverseitige Bestätigung durch den Stripe-Webhook warten
      $('successSub').textContent = 'Zahlung wird bestätigt – einen Moment bitte …';
      $('successTickets').innerHTML = '';
      openModal('successModal');
      order = await S.waitForPayment(orderId, 30000);
      if (!order || order.status !== 'bezahlt') {
        $('successSub').textContent = 'Deine Zahlung wird noch verarbeitet. ' +
          'Die Tickets erscheinen in wenigen Minuten unter „Meine Tickets“ – bitte Seite später neu laden.';
        return;
      }
    } else {
      const orderId = S.consumePendingPayment();
      if (!orderId) return;
      order = await S.confirmOnlinePayment(orderId);
      if (!order) return;
    }

    await refreshShop();
    $('successSub').textContent = 'Zahlung erfolgreich! Bestellnummer ' + order.id + ' · ' +
      order.tickets.length + ' Ticket(s) · ' + S.fmtEUR.format(order.total) +
      ' – deine Tickets sind jetzt gültig und stehen unten als PDF bereit.';
    $('successTickets').innerHTML =
      '<p style="margin:10px 0"><button class="btn btn-gold btn-sm" id="btnSuccessPdf">Tickets als PDF herunterladen</button></p>' +
      order.tickets.map(t => ticketHTML(t, order)).join('');
    openModal('successModal');
    drawQRCodes($('successTickets'));
    const pdfBtn = document.getElementById('btnSuccessPdf');
    if (pdfBtn) pdfBtn.addEventListener('click', () => window.CMTicketPDF.download(order));
  }

  /* ---------- Meine Tickets ---------- */
  function ticketHTML(t, order) {
    const paid = order.status === 'bezahlt';
    return '<div class="ticket">' +
      (paid
        ? '<div class="qr" data-code="' + esc(t.code) + '"></div>'
        : '<div class="qr qr-pending"><div>QR-Code nach<br>Zahlungseingang</div></div>') +
      '<div class="tinfo">' +
      '<div class="tcode">' + esc(t.code) + '</div>' +
      '<div>' + esc(t.categoryName) + ' – ' + esc(t.eventName) + '</div>' +
      '<div class="tmeta">' + fmtDate(t.eventDate) + (t.eventLocation ? ' · ' + esc(t.eventLocation) : '') +
      ' · ' + S.fmtEUR.format(t.price) + '</div>' +
      '<div style="margin-top:6px">' +
      '<span class="badge ' + esc(order.status) + '">' +
      (order.status === 'offen' ? 'reserviert – Zahlung ausstehend' : esc(order.status)) + '</span> ' +
      (t.checkedIn ? '<span class="badge checked">eingecheckt</span>' : '') +
      '</div></div></div>';
  }

  function drawQRCodes(root) {
    root.querySelectorAll('.qr[data-code]').forEach(el => {
      if (el.dataset.done) return;
      el.dataset.done = '1';
      try {
        const cv = window.CMTicketPDF.qrCanvas(el.dataset.code, 96);
        cv.style.width = cv.style.height = '100%';
        el.appendChild(cv);
      } catch (e) {
        el.innerHTML = '<div style="color:#000;font-size:11px;word-break:break-all;padding:4px">' + esc(el.dataset.code) + '</div>';
      }
    });
  }

  window.renderMyTickets = async function () {
    const box = $('myTicketsArea');
    const user = S.currentUser();
    if (!user) {
      box.innerHTML = '<p class="sub">Bitte melde dich mit deiner E-Mail-Adresse an, um deine Tickets zu sehen.</p>' +
        '<p style="margin-top:14px"><button class="btn btn-ghost" onclick="openLogin()">Jetzt anmelden</button></p>';
      return;
    }
    let orders;
    try {
      orders = (await S.ordersForUser()).slice().reverse();
    } catch (e) {
      box.innerHTML = '<p class="sub">Bestellungen konnten nicht geladen werden: ' + esc(e.message) + '</p>';
      return;
    }
    if (!orders.length) {
      box.innerHTML = '<p class="sub">Angemeldet als <b style="color:var(--gold)">' + esc(user) +
        '</b> – noch keine Bestellungen vorhanden.</p>';
      return;
    }
    const canRetry = o => o.status === 'offen' &&
      (S.remote ? SETTINGS.stripeEnabled : !!S.orderPaymentLink(o));

    box.innerHTML = orders.map(o =>
      '<div style="margin-bottom:26px"><div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
      '<b>Bestellung ' + esc(o.id) + '</b>' +
      '<span class="badge ' + esc(o.status) + '">' +
      (o.status === 'offen' ? 'reserviert – Zahlung ausstehend' : esc(o.status)) + '</span>' +
      '<span class="sub">' + new Date(o.createdAt).toLocaleString('de-AT') + ' · ' + S.fmtEUR.format(o.total) + '</span>' +
      (o.status === 'bezahlt'
        ? '<button class="btn btn-ghost btn-sm" data-pdf="' + esc(o.id) + '">Tickets als PDF</button>'
        : '') +
      (canRetry(o)
        ? '<button class="btn btn-gold btn-sm" data-pay="' + esc(o.id) + '">Jetzt online bezahlen</button>'
        : '') +
      '</div>' +
      (o.status === 'offen'
        ? '<p class="hint" style="margin-top:6px">' +
          (canRetry(o)
            ? 'Die Zahlung wurde noch nicht abgeschlossen. Über „Jetzt online bezahlen“ kannst du sie nachholen – danach werden die Tickets freigeschaltet (QR-Code + PDF).'
            : esc(SETTINGS.checkoutNote) + ' Nach Zahlungseingang werden die Tickets freigeschaltet (QR-Code + PDF).') +
          '</p>'
        : '') +
      o.tickets.map(t => ticketHTML(t, o)).join('') + '</div>').join('');
    drawQRCodes(box);

    box.querySelectorAll('[data-pdf]').forEach(b => b.addEventListener('click', () => {
      const order = orders.find(o => o.id === b.dataset.pdf);
      if (order) window.CMTicketPDF.download(order);
    }));
    box.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', async () => {
      try {
        b.disabled = true;
        b.textContent = 'Wird geöffnet …';
        const url = await S.retryPayment(b.dataset.pay);
        window.location.href = url;
      } catch (e) {
        alert(e.message);
        b.disabled = false;
        b.textContent = 'Jetzt online bezahlen';
      }
    }));
  };

  /* ---------- Init ---------- */
  async function init() {
    $('btnSendCode').addEventListener('click', () => sendCode(false));
    $('btnResend').addEventListener('click', () => sendCode(true));
    $('btnVerify').addEventListener('click', verify);
    $('loginCode').addEventListener('keydown', e => { if (e.key === 'Enter') verify(); });
    $('loginEmail').addEventListener('keydown', e => { if (e.key === 'Enter') sendCode(false); });
    $('btnCheckout').addEventListener('click', openCheckout);
    $('btnPlaceOrder').addEventListener('click', placeOrder);
    $('navMyTickets').addEventListener('click', () => setTimeout(renderMyTickets, 0));

    await S.init();
    renderNav();
    try {
      await loadData();
    } catch (e) {
      $('eventList').innerHTML = '<div class="card"><h2>Shop derzeit nicht erreichbar</h2>' +
        '<p class="sub">' + esc(e.message) + '</p></div>';
      return;
    }
    renderEvents();
    renderCartBar();
    await renderMyTickets();
    await handlePaymentReturn();
  }

  init();
})();
