/* CORE Management Ticketshop – Dashboard-Logik (dashboard.html) */
(function () {
  'use strict';
  const S = window.CMStore;
  const $ = id => document.getElementById(id);
  const GOLD = '#B08A28'; // validierte Diagrammfarbe auf dunklem Grund

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function msg(el, text, type) {
    el.textContent = text || '';
    el.className = 'msg' + (text ? ' show ' + (type || 'info') : '');
  }
  function fmtDT(iso) { return iso ? new Date(iso).toLocaleString('de-AT') : ''; }

  /* ================= PIN-Gate ================= */
  async function tryPin() {
    try {
      await S.adminLogin($('pinInput').value);
      showDash();
    } catch (e) { msg($('pinMsg'), e.message, 'error'); }
  }
  function showDash() {
    $('pinGate').style.display = 'none';
    $('dash').style.display = '';
    $('adminLogout').style.display = '';
    renderAll();
  }
  $('btnPin').addEventListener('click', tryPin);
  $('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryPin(); });
  $('adminLogout').addEventListener('click', e => {
    e.preventDefault(); S.adminLogout(); location.reload();
  });
  if (S.adminLoggedIn()) showDash();

  /* ================= Tabs ================= */
  document.querySelectorAll('#tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tabpane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.tab).classList.add('active');
    });
  });

  /* ================= Übersicht ================= */
  function renderStats() {
    const st = S.stats();
    $('statTiles').innerHTML = [
      ['Umsatz', S.fmtEUR.format(st.revenue), st.openCount + ' Bestellung(en) offen'],
      ['Verkaufte Tickets', st.ticketCount, 'über ' + st.orderCount + ' Bestellungen'],
      ['Check-ins', st.checkinCount, st.ticketCount ? Math.round(100 * st.checkinCount / st.ticketCount) + ' % eingecheckt' : '–'],
      ['Registrierte Käufer:innen', st.userCount, 'per E-Mail verifiziert']
    ].map(t => '<div class="stat-tile"><div class="k">' + t[0] + '</div><div class="v">' + t[1] +
      '</div><div class="s">' + t[2] + '</div></div>').join('');
  }

  /* --- SVG-Balkendiagramm: Verkäufe der letzten 14 Tage --- */
  function chartSales() {
    const data = S.salesByDay(14);
    const W = 560, H = 240, pad = { l: 34, r: 8, t: 12, b: 26 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const maxV = Math.max(1, ...data.map(d => d.qty));
    const step = iw / data.length;
    const barW = Math.max(6, step - 6);
    const ticks = [0, Math.ceil(maxV / 2), maxV];

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="min-width:420px" role="img" aria-label="Verkaufte Tickets pro Tag">';
    ticks.forEach(t => {
      const y = pad.t + ih - (t / maxV) * ih;
      svg += '<line x1="' + pad.l + '" y1="' + y + '" x2="' + (W - pad.r) + '" y2="' + y +
        '" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>' +
        '<text x="' + (pad.l - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#6f6f6f">' + t + '</text>';
    });
    data.forEach((d, i) => {
      const h = (d.qty / maxV) * ih;
      const x = pad.l + i * step + (step - barW) / 2;
      const y = pad.t + ih - h;
      svg += '<g class="bar" data-i="' + i + '">' +
        (d.qty > 0
          ? '<path d="M' + x + ' ' + (pad.t + ih) + ' V' + (y + 4) + ' Q' + x + ' ' + y + ' ' + (x + 4) + ' ' + y +
            ' H' + (x + barW - 4) + ' Q' + (x + barW) + ' ' + y + ' ' + (x + barW) + ' ' + (y + 4) +
            ' V' + (pad.t + ih) + ' Z" fill="' + GOLD + '"/>'
          : '<line x1="' + x + '" y1="' + (pad.t + ih) + '" x2="' + (x + barW) + '" y2="' + (pad.t + ih) +
            '" stroke="rgba(255,255,255,0.15)" stroke-width="2"/>') +
        '<rect x="' + (pad.l + i * step) + '" y="' + pad.t + '" width="' + step + '" height="' + ih +
        '" fill="transparent"/></g>';
      if (i % 2 === 0) {
        svg += '<text x="' + (pad.l + i * step + step / 2) + '" y="' + (H - 8) +
          '" text-anchor="middle" font-size="10" fill="#6f6f6f">' + d.label + '</text>';
      }
    });
    svg += '</svg><div class="chart-tip"></div>';
    const wrap = $('chartSales');
    wrap.innerHTML = svg;
    attachTip(wrap, i => {
      const d = data[i];
      return '<b>' + d.label + '</b> · ' + d.qty + ' Ticket(s) · ' + S.fmtEUR.format(d.revenue);
    });
  }

  /* --- SVG-Balkendiagramm horizontal: Umsatz nach Kategorie --- */
  function chartRevenue() {
    const data = S.revenueByCategory().slice(0, 8);
    const wrap = $('chartRevenue');
    if (!data.length) {
      wrap.innerHTML = '<p class="sub">Noch keine Verkäufe vorhanden.</p>';
      return;
    }
    const W = 560, rowH = 40, pad = { l: 10, r: 90, t: 6, b: 6 };
    const H = pad.t + pad.b + data.length * rowH;
    const iw = W - pad.l - pad.r;
    const maxV = Math.max(1, ...data.map(d => d.revenue));

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="min-width:420px" role="img" aria-label="Umsatz nach Ticketkategorie">';
    data.forEach((d, i) => {
      const y = pad.t + i * rowH;
      const w = Math.max(3, (d.revenue / maxV) * iw);
      const by = y + 20;
      svg += '<g class="bar" data-i="' + i + '">' +
        '<text x="' + pad.l + '" y="' + (y + 13) + '" font-size="11" fill="#F5F0EB">' + esc(d.label) +
        ' <tspan fill="#6f6f6f">· ' + esc(d.event) + '</tspan></text>' +
        '<path d="M' + pad.l + ' ' + by + ' H' + (pad.l + w - 4) + ' Q' + (pad.l + w) + ' ' + by + ' ' +
        (pad.l + w) + ' ' + (by + 4) + ' V' + (by + 8) + ' Q' + (pad.l + w) + ' ' + (by + 12) + ' ' +
        (pad.l + w - 4) + ' ' + (by + 12) + ' H' + pad.l + ' Z" fill="' + GOLD + '"/>' +
        '<text x="' + (pad.l + w + 8) + '" y="' + (by + 10) + '" font-size="11" fill="#999">' +
        S.fmtEUR.format(d.revenue) + '</text>' +
        '<rect x="0" y="' + y + '" width="' + W + '" height="' + rowH + '" fill="transparent"/></g>';
    });
    svg += '</svg><div class="chart-tip"></div>';
    wrap.innerHTML = svg;
    attachTip(wrap, i => {
      const d = data[i];
      return '<b>' + esc(d.label) + '</b> · ' + d.qty + ' Ticket(s) · ' + S.fmtEUR.format(d.revenue);
    });
  }

  function attachTip(wrap, html) {
    const tip = wrap.querySelector('.chart-tip');
    wrap.querySelectorAll('g.bar').forEach(g => {
      g.addEventListener('mousemove', e => {
        tip.innerHTML = html(parseInt(g.dataset.i, 10));
        tip.style.display = 'block';
        const r = wrap.getBoundingClientRect();
        let x = e.clientX - r.left + 12, y = e.clientY - r.top - 34;
        if (x + tip.offsetWidth > r.width) x = x - tip.offsetWidth - 24;
        tip.style.left = x + 'px'; tip.style.top = Math.max(0, y) + 'px';
      });
      g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  }

  function renderQuota() {
    const sold = S.soldByCategory();
    let rows = '<tr><th>Event</th><th>Kategorie</th><th>Preis</th><th>Verkauft</th><th>Kontingent</th><th>Auslastung</th></tr>';
    S.getEvents().forEach(ev => ev.categories.forEach(cat => {
      const s = sold[cat.id] || 0;
      const pct = cat.quota ? Math.round(100 * s / cat.quota) : 0;
      rows += '<tr><td>' + esc(ev.name) + '</td><td>' + esc(cat.name) + '</td>' +
        '<td>' + S.fmtEUR.format(cat.price) + '</td><td>' + s + '</td><td>' + cat.quota + '</td>' +
        '<td><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;max-width:140px;height:6px;background:rgba(255,255,255,.08);border-radius:3px">' +
        '<div style="width:' + Math.min(100, pct) + '%;height:6px;background:' + GOLD + ';border-radius:3px"></div></div>' +
        '<span style="color:#999;font-size:12px">' + pct + ' %</span></div></td></tr>';
    }));
    $('quotaTable').innerHTML = rows;
  }

  /* ================= Events & Tickets (modular) ================= */
  function renderAdminEvents() {
    const sold = S.soldByCategory();
    const evs = S.getEvents();
    $('adminEvents').innerHTML = evs.length ? evs.map(ev =>
      '<div class="card"><div class="event-head"><h2>' + esc(ev.name) + '</h2>' +
      '<span class="badge ' + (ev.active ? 'bezahlt' : 'storniert') + '">' + (ev.active ? 'aktiv' : 'inaktiv') + '</span>' +
      '<span class="event-meta">' + fmtDT(ev.date) + (ev.location ? ' · ' + esc(ev.location) : '') + '</span></div>' +
      '<div class="table-scroll"><table class="data"><tr><th>Kategorie</th><th>Preis</th><th>Kontingent</th><th>Verkauft</th><th>Status</th></tr>' +
      ev.categories.map(c => '<tr><td>' + esc(c.name) + '</td><td>' + S.fmtEUR.format(c.price) + '</td><td>' + c.quota +
        '</td><td>' + (sold[c.id] || 0) + '</td><td>' + (c.active ? 'aktiv' : 'inaktiv') + '</td></tr>').join('') +
      '</table></div>' +
      '<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost btn-sm" data-edit="' + ev.id + '">Bearbeiten</button>' +
      '<button class="btn btn-ghost btn-sm" data-toggle="' + ev.id + '">' + (ev.active ? 'Deaktivieren' : 'Aktivieren') + '</button>' +
      '<button class="btn btn-danger btn-sm" data-del="' + ev.id + '">Löschen</button>' +
      '</div></div>').join('')
      : '<div class="card"><p class="sub">Noch keine Events angelegt.</p></div>';

    $('adminEvents').querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEventEditor(b.dataset.edit)));
    $('adminEvents').querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
      const ev = S.getEvent(b.dataset.toggle); ev.active = !ev.active; S.upsertEvent(ev); renderAll();
    }));
    $('adminEvents').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      const ev = S.getEvent(b.dataset.del);
      if (confirm('Event „' + ev.name + '“ wirklich löschen? Bestehende Bestellungen bleiben erhalten.')) {
        S.deleteEvent(ev.id); renderAll();
      }
    }));
  }

  function catRowHTML(c) {
    c = c || { id: S.uid('cat'), name: '', price: '', quota: '', description: '', active: true, maxPerOrder: 10 };
    return '<div class="admin-cat" data-cat="' + c.id + '">' +
      '<div style="flex:2 1 160px"><label>Name</label><input type="text" class="c-name" value="' + esc(c.name) + '" placeholder="z. B. VIP"></div>' +
      '<div><label>Preis (€)</label><input type="number" class="c-price" min="0" step="0.5" value="' + esc(c.price) + '"></div>' +
      '<div><label>Kontingent</label><input type="number" class="c-quota" min="0" step="1" value="' + esc(c.quota) + '"></div>' +
      '<div><label>Max./Bestellung</label><input type="number" class="c-max" min="1" step="1" value="' + esc(c.maxPerOrder || 10) + '"></div>' +
      '<div style="flex:2 1 200px"><label>Beschreibung</label><input type="text" class="c-desc" value="' + esc(c.description) + '"></div>' +
      '<div style="flex:0 0 auto"><label class="switch" style="margin:0 0 8px"><input type="checkbox" class="c-active"' + (c.active ? ' checked' : '') + '> aktiv</label>' +
      '<button type="button" class="btn btn-danger btn-sm c-remove">Entfernen</button></div>' +
      '</div>';
  }

  function openEventEditor(id) {
    const ev = id ? S.getEvent(id) : null;
    $('evModalTitle').textContent = ev ? 'Event bearbeiten' : 'Neues Event';
    $('evId').value = ev ? ev.id : '';
    $('evName').value = ev ? ev.name : '';
    $('evDate').value = ev ? (ev.date || '') : '';
    $('evLocation').value = ev ? (ev.location || '') : '';
    $('evDesc').value = ev ? (ev.description || '') : '';
    $('evActive').checked = ev ? !!ev.active : true;
    $('catEditor').innerHTML = (ev && ev.categories.length ? ev.categories : [null]).map(catRowHTML).join('');
    bindCatRemove();
    msg($('evMsg'), '');
    $('eventModal').classList.add('open');
  }

  function bindCatRemove() {
    $('catEditor').querySelectorAll('.c-remove').forEach(b => {
      b.onclick = () => b.closest('.admin-cat').remove();
    });
  }

  $('btnAddCat').addEventListener('click', () => {
    $('catEditor').insertAdjacentHTML('beforeend', catRowHTML(null));
    bindCatRemove();
  });

  $('btnNewEvent').addEventListener('click', () => openEventEditor(null));

  $('btnSaveEvent').addEventListener('click', () => {
    const id = $('evId').value;
    const old = id ? S.getEvent(id) : null;
    const cats = Array.from($('catEditor').querySelectorAll('.admin-cat')).map(row => ({
      id: row.dataset.cat,
      name: row.querySelector('.c-name').value.trim(),
      price: parseFloat(row.querySelector('.c-price').value) || 0,
      quota: parseInt(row.querySelector('.c-quota').value, 10) || 0,
      maxPerOrder: parseInt(row.querySelector('.c-max').value, 10) || 10,
      description: row.querySelector('.c-desc').value.trim(),
      active: row.querySelector('.c-active').checked
    })).filter(c => c.name);
    const ev = {
      id: id || S.uid('ev'),
      name: $('evName').value.trim(),
      date: $('evDate').value,
      location: $('evLocation').value.trim(),
      description: $('evDesc').value.trim(),
      active: $('evActive').checked,
      categories: cats
    };
    if (!ev.name) { msg($('evMsg'), 'Bitte einen Eventnamen eingeben.', 'error'); return; }
    if (!cats.length) { msg($('evMsg'), 'Bitte mindestens eine Ticketkategorie anlegen.', 'error'); return; }
    if (old) ev.createdAt = old.createdAt;
    S.upsertEvent(ev);
    $('eventModal').classList.remove('open');
    renderAll();
  });

  /* ================= Bestellungen ================= */
  function renderOrders() {
    const q = ($('orderSearch').value || '').trim().toLowerCase();
    const f = $('orderFilter').value;
    let orders = S.getOrders().slice().reverse();
    if (f) orders = orders.filter(o => o.status === f);
    if (q) orders = orders.filter(o =>
      o.id.toLowerCase().includes(q) || o.email.includes(q) ||
      o.tickets.some(t => t.code.toLowerCase().includes(q)));

    let rows = '<tr><th>Bestellung</th><th>Datum</th><th>E-Mail</th><th>Tickets</th><th>Summe</th><th>Status</th><th></th></tr>';
    if (!orders.length) rows += '<tr><td colspan="7" style="color:#6f6f6f">Keine Bestellungen gefunden.</td></tr>';
    orders.forEach(o => {
      rows += '<tr><td><b>' + esc(o.id) + '</b></td><td>' + fmtDT(o.createdAt) + '</td>' +
        '<td>' + esc(o.email) + '</td>' +
        '<td>' + o.items.map(i => i.qty + '× ' + esc(i.categoryName)).join('<br>') + '</td>' +
        '<td>' + S.fmtEUR.format(o.total) + '</td>' +
        '<td><span class="badge ' + esc(o.status) + '">' + esc(o.status) + '</span></td>' +
        '<td style="white-space:nowrap">' +
        (o.status === 'offen' ? '<button class="btn btn-ghost btn-sm" data-paid="' + o.id + '">Als bezahlt markieren</button> ' : '') +
        (o.status === 'bezahlt' ? '<button class="btn btn-ghost btn-sm" data-pdf="' + o.id + '">Tickets-PDF</button> ' : '') +
        (o.status !== 'storniert' ? '<button class="btn btn-danger btn-sm" data-cancel="' + o.id + '">Stornieren</button>' : '') +
        '</td></tr>';
    });
    $('orderTable').innerHTML = rows;
    $('orderTable').querySelectorAll('[data-paid]').forEach(b => b.addEventListener('click', () => {
      S.setOrderStatus(b.dataset.paid, 'bezahlt'); renderAll();
    }));
    $('orderTable').querySelectorAll('[data-pdf]').forEach(b => b.addEventListener('click', () => {
      const order = S.getOrders().find(o => o.id === b.dataset.pdf);
      if (order) window.CMTicketPDF.download(order);
    }));
    $('orderTable').querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => {
      if (confirm('Bestellung ' + b.dataset.cancel + ' stornieren? Die Tickets werden ungültig und das Kontingent wieder frei.')) {
        S.setOrderStatus(b.dataset.cancel, 'storniert'); renderAll();
      }
    }));
  }
  $('orderSearch').addEventListener('input', renderOrders);
  $('orderFilter').addEventListener('change', renderOrders);

  $('btnCSV').addEventListener('click', () => {
    const blob = new Blob(['﻿' + S.exportOrdersCSV()], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ticketshop-bestellungen-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ================= Check-in ================= */
  function renderCheckins() {
    const all = S.getOrders().flatMap(o => o.tickets.filter(t => t.checkedIn)
      .map(t => ({ t, email: o.email })))
      .sort((a, b) => new Date(b.t.checkedInAt) - new Date(a.t.checkedInAt)).slice(0, 20);
    let rows = '<tr><th>Zeit</th><th>Ticketcode</th><th>Kategorie</th><th>Event</th><th>E-Mail</th></tr>';
    if (!all.length) rows += '<tr><td colspan="5" style="color:#6f6f6f">Noch keine Check-ins.</td></tr>';
    all.forEach(({ t, email }) => {
      rows += '<tr><td>' + fmtDT(t.checkedInAt) + '</td><td><b>' + esc(t.code) + '</b></td><td>' +
        esc(t.categoryName) + '</td><td>' + esc(t.eventName) + '</td><td>' + esc(email) + '</td></tr>';
    });
    $('checkinTable').innerHTML = rows;
  }

  function doCheckin() {
    try {
      const found = S.checkIn($('checkinCode').value);
      msg($('checkinMsg'), '✓ Eingecheckt: ' + found.ticket.code + ' – ' + found.ticket.categoryName +
        ' (' + found.order.email + ')', 'ok');
      $('checkinCode').value = '';
      renderAll();
    } catch (e) { msg($('checkinMsg'), e.message, 'error'); }
    $('checkinCode').focus();
  }
  $('btnCheckin').addEventListener('click', doCheckin);
  $('checkinCode').addEventListener('keydown', e => { if (e.key === 'Enter') doCheckin(); });

  /* ================= Einstellungen ================= */
  function loadSettingsForm() {
    const s = S.getSettings();
    $('ejService').value = s.emailjs.serviceId;
    $('ejTemplate').value = s.emailjs.templateId;
    $('ejKey').value = s.emailjs.publicKey;
    $('checkoutNote').value = s.checkoutNote;
  }

  $('btnSaveEJ').addEventListener('click', () => {
    S.saveSettings({ emailjs: {
      serviceId: $('ejService').value.trim(),
      templateId: $('ejTemplate').value.trim(),
      publicKey: $('ejKey').value.trim()
    }});
    msg($('ejMsg'), S.emailConfigured()
      ? 'Gespeichert – E-Mail-Versand ist aktiv.'
      : 'Gespeichert – Felder unvollständig, der Shop bleibt im Demo-Modus.', 'ok');
  });

  $('btnTestEJ').addEventListener('click', async () => {
    if (!S.emailConfigured()) { msg($('ejMsg'), 'Bitte zuerst alle drei EmailJS-Felder ausfüllen und speichern.', 'error'); return; }
    const to = prompt('Test-E-Mail senden an:');
    if (!to) return;
    try {
      msg($('ejMsg'), 'Sende Test-E-Mail …', 'info');
      await S.sendEmail(S.normEmail(to), {
        subject: 'Test – CORE Management Ticketshop',
        passcode: '123456',
        message: 'Dies ist eine Test-E-Mail aus dem Ticketshop-Dashboard. Konfiguration erfolgreich!'
      });
      msg($('ejMsg'), 'Test-E-Mail wurde gesendet an ' + to + '.', 'ok');
    } catch (e) { msg($('ejMsg'), e.message, 'error'); }
  });

  $('btnSaveNote').addEventListener('click', () => {
    S.saveSettings({ checkoutNote: $('checkoutNote').value.trim() });
    alert('Checkout-Hinweis gespeichert.');
  });

  $('btnSavePin').addEventListener('click', async () => {
    const p1 = $('newPin').value, p2 = $('newPin2').value;
    if (p1 !== p2) { msg($('pinChangeMsg'), 'Die PINs stimmen nicht überein.', 'error'); return; }
    try {
      await S.setAdminPin(p1);
      $('newPin').value = ''; $('newPin2').value = '';
      msg($('pinChangeMsg'), 'PIN wurde geändert.', 'ok');
    } catch (e) { msg($('pinChangeMsg'), e.message, 'error'); }
  });

  $('btnReset').addEventListener('click', () => {
    if (confirm('Wirklich ALLE Shop-Daten (Events, Bestellungen, Nutzer, Einstellungen) löschen?') &&
        confirm('Letzte Warnung: Diese Aktion kann nicht rückgängig gemacht werden.')) {
      Object.values(S.KEYS).forEach(k => localStorage.removeItem(k));
      location.reload();
    }
  });

  /* ================= Gesamt-Render ================= */
  function renderAll() {
    renderStats();
    chartSales();
    chartRevenue();
    renderQuota();
    renderAdminEvents();
    renderOrders();
    renderCheckins();
    loadSettingsForm();
  }
})();
