/* CORE Management Ticketshop – Dashboard-Logik (dashboard.html)
   Backend: Supabase – Anmeldung per E-Mail-Verifizierung, Admin-Rechte über RLS. */
(function () {
  'use strict';
  const S = window.CMStore;
  const $ = id => document.getElementById(id);
  const GOLD = '#B08A28'; // validierte Diagrammfarbe auf dunklem Grund

  let orders = [];   // Cache aller Bestellungen
  let events = [];   // Cache aller Events (inkl. inaktive)
  let gateEmail = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function msg(el, text, type) {
    el.textContent = text || '';
    el.className = 'msg' + (text ? ' show ' + (type || 'info') : '');
  }
  function fmtDT(iso) { return iso ? new Date(iso).toLocaleString('de-AT') : ''; }

  /* ================= Login-Gate ================= */
  async function gateSend() {
    try {
      $('btnGateSend').disabled = true;
      msg($('gateMsg1'), 'E-Mail wird gesendet …', 'info');
      gateEmail = S.normEmail($('adminEmail').value);
      await S.requestCode(gateEmail);
      $('gateStep1').style.display = 'none';
      $('gateStep2').style.display = '';
      $('gateSentInfo').textContent = 'E-Mail an ' + gateEmail + ' gesendet – Link anklicken oder Code eingeben.';
      msg($('gateMsg1'), '');
      $('adminCode').focus();
    } catch (e) {
      msg($('gateMsg1'), e.message, 'error');
    } finally {
      $('btnGateSend').disabled = false;
    }
  }

  async function gateVerify() {
    try {
      $('btnGateVerify').disabled = true;
      await S.verifyCode(gateEmail, $('adminCode').value);
      await enter();
    } catch (e) {
      msg($('gateMsg2'), e.message, 'error');
    } finally {
      $('btnGateVerify').disabled = false;
    }
  }

  async function enter() {
    const user = S.currentUser();
    if (!user) return; // bleibt am Gate
    if (!(await S.isAdmin())) {
      $('gateStep1').style.display = '';
      $('gateStep2').style.display = 'none';
      msg($('gateDenied'), 'Angemeldet als ' + user + ' – dieses Konto hat keine Admin-Rechte. ' +
        'Ein bestehender Admin kann dich unter „Einstellungen → Admins verwalten“ freischalten.', 'error');
      return;
    }
    $('loginGate').style.display = 'none';
    $('dash').style.display = '';
    $('adminLogout').style.display = '';
    $('adminLogout').textContent = user + ' · Abmelden';
    await renderAll();
  }

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
    const st = S.stats(orders);
    $('statTiles').innerHTML = [
      ['Umsatz (bezahlt)', S.fmtEUR.format(st.revenue), st.openCount + ' Bestellung(en) offen/abgebrochen'],
      ['Verkaufte Tickets', st.ticketCount, 'über ' + st.orderCount + ' Bestellungen'],
      ['Check-ins', st.checkinCount, st.ticketCount ? Math.round(100 * st.checkinCount / st.ticketCount) + ' % eingecheckt' : '–'],
      ['Zahlungsart', 'Stripe', 'serverseitig bestätigt']
    ].map(t => '<div class="stat-tile"><div class="k">' + t[0] + '</div><div class="v">' + t[1] +
      '</div><div class="s">' + t[2] + '</div></div>').join('');
  }

  function chartSales() {
    const data = S.salesByDay(orders, 14);
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

  function chartRevenue() {
    const data = S.revenueByCategory(orders).slice(0, 8);
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
    let rows = '<tr><th>Event</th><th>Kategorie</th><th>Preis</th><th>Verkauft</th><th>Kontingent</th><th>Auslastung</th></tr>';
    events.forEach(ev => ev.categories.forEach(cat => {
      const pct = cat.quota ? Math.round(100 * cat.sold / cat.quota) : 0;
      rows += '<tr><td>' + esc(ev.name) + '</td><td>' + esc(cat.name) + '</td>' +
        '<td>' + S.fmtEUR.format(cat.price) + '</td><td>' + cat.sold + '</td><td>' + cat.quota + '</td>' +
        '<td><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;max-width:140px;height:6px;background:rgba(255,255,255,.08);border-radius:3px">' +
        '<div style="width:' + Math.min(100, pct) + '%;height:6px;background:' + GOLD + ';border-radius:3px"></div></div>' +
        '<span style="color:#999;font-size:12px">' + pct + ' %</span></div></td></tr>';
    }));
    $('quotaTable').innerHTML = rows;
  }

  /* ================= Events & Tickets ================= */
  function renderAdminEvents() {
    $('adminEvents').innerHTML = events.length ? events.map(ev =>
      '<div class="card"><div class="event-head"><h2>' + esc(ev.name) + '</h2>' +
      '<span class="badge ' + (ev.active ? 'bezahlt' : 'storniert') + '">' + (ev.active ? 'aktiv' : 'inaktiv') + '</span>' +
      '<span class="event-meta">' + fmtDT(ev.date) + (ev.location ? ' · ' + esc(ev.location) : '') + '</span></div>' +
      '<div class="table-scroll"><table class="data"><tr><th>Kategorie</th><th>Preis</th><th>Kontingent</th><th>Verkauft</th><th>Status</th></tr>' +
      ev.categories.map(c => '<tr><td>' + esc(c.name) + '</td><td>' + S.fmtEUR.format(c.price) + '</td><td>' + c.quota +
        '</td><td>' + c.sold + '</td><td>' + (c.active ? 'aktiv' : 'inaktiv') + '</td></tr>').join('') +
      '</table></div>' +
      '<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost btn-sm" data-edit="' + ev.id + '">Bearbeiten</button>' +
      '<button class="btn btn-ghost btn-sm" data-toggle="' + ev.id + '">' + (ev.active ? 'Deaktivieren' : 'Aktivieren') + '</button>' +
      '<button class="btn btn-danger btn-sm" data-del="' + ev.id + '">Löschen</button>' +
      '</div></div>').join('')
      : '<div class="card"><p class="sub">Noch keine Events angelegt.</p></div>';

    $('adminEvents').querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEventEditor(b.dataset.edit)));
    $('adminEvents').querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
      const ev = events.find(x => x.id === b.dataset.toggle);
      try { await S.setEventActive(ev.id, !ev.active); await renderAll(); }
      catch (e) { alert(e.message); }
    }));
    $('adminEvents').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const ev = events.find(x => x.id === b.dataset.del);
      if (confirm('Event „' + ev.name + '“ wirklich löschen?')) {
        try { await S.deleteEvent(ev.id); await renderAll(); }
        catch (e) { alert('Löschen nicht möglich: ' + e.message + '\nTipp: Events mit Bestellungen besser deaktivieren.'); }
      }
    }));
  }

  function catRowHTML(c) {
    c = c || { id: '', name: '', price: '', quota: '', description: '', active: true, maxPerOrder: 10 };
    return '<div class="admin-cat" data-cat="' + esc(c.id) + '">' +
      '<div style="flex:2 1 160px"><label>Name</label><input type="text" class="c-name" value="' + esc(c.name) + '" placeholder="z. B. VIP"></div>' +
      '<div><label>Preis (€)</label><input type="number" class="c-price" min="0" step="0.5" value="' + esc(c.price) + '"></div>' +
      '<div><label>Kontingent</label><input type="number" class="c-quota" min="0" step="1" value="' + esc(c.quota) + '"></div>' +
      '<div><label>Max./Bestellung</label><input type="number" class="c-max" min="1" step="1" value="' + esc(c.maxPerOrder || 10) + '"></div>' +
      '<div style="flex:2 1 200px"><label>Beschreibung</label><input type="text" class="c-desc" value="' + esc(c.description || '') + '"></div>' +
      '<div style="flex:0 0 auto"><label class="switch" style="margin:0 0 8px"><input type="checkbox" class="c-active"' + (c.active ? ' checked' : '') + '> aktiv</label>' +
      '<button type="button" class="btn btn-danger btn-sm c-remove">Entfernen</button></div>' +
      '</div>';
  }

  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function openEventEditor(id) {
    const ev = id ? events.find(x => x.id === id) : null;
    $('evModalTitle').textContent = ev ? 'Event bearbeiten' : 'Neues Event';
    $('evId').value = ev ? ev.id : '';
    $('evName').value = ev ? ev.name : '';
    $('evDate').value = ev ? toLocalInput(ev.date) : '';
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

  /* ================= Bestellungen ================= */
  function renderOrders() {
    const q = ($('orderSearch').value || '').trim().toLowerCase();
    const f = $('orderFilter').value;
    let list = orders;
    if (f) list = list.filter(o => o.status === f);
    if (q) list = list.filter(o =>
      o.id.toLowerCase().includes(q) || o.email.includes(q) ||
      o.tickets.some(t => t.code.toLowerCase().includes(q)));

    let rows = '<tr><th>Bestellung</th><th>Datum</th><th>E-Mail</th><th>Tickets</th><th>Summe</th><th>Status</th><th></th></tr>';
    if (!list.length) rows += '<tr><td colspan="7" style="color:#6f6f6f">Keine Bestellungen gefunden.</td></tr>';
    list.forEach(o => {
      rows += '<tr><td><b>' + esc(o.id) + '</b></td><td>' + fmtDT(o.createdAt) + '</td>' +
        '<td>' + esc(o.email) + '</td>' +
        '<td>' + o.items.map(i => i.qty + '× ' + esc(i.categoryName)).join('<br>') + '</td>' +
        '<td>' + S.fmtEUR.format(o.total) + '</td>' +
        '<td><span class="badge ' + esc(o.status) + '">' + esc(o.status) +
        (o.paidVia === 'stripe' ? ' · Stripe' : '') + '</span></td>' +
        '<td style="white-space:nowrap">' +
        (o.status === 'bezahlt' ? '<button class="btn btn-ghost btn-sm" data-pdf="' + o.id + '">Tickets-PDF</button> ' : '') +
        (o.status !== 'storniert' ? '<button class="btn btn-danger btn-sm" data-cancel="' + o.id + '">Stornieren</button>' : '') +
        '</td></tr>';
    });
    $('orderTable').innerHTML = rows;
    $('orderTable').querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
      if (confirm('Bestellung ' + b.dataset.cancel + ' stornieren? Die Tickets werden ungültig und das Kontingent wieder frei. (Rückerstattung ggf. im Stripe-Dashboard!)')) {
        try { await S.setOrderStatus(b.dataset.cancel, 'storniert'); await renderAll(); }
        catch (e) { alert(e.message); }
      }
    }));
    $('orderTable').querySelectorAll('[data-pdf]').forEach(b => b.addEventListener('click', () => {
      const order = orders.find(o => o.id === b.dataset.pdf);
      if (order) window.CMTicketPDF.download(order);
    }));
  }

  /* ================= Check-in ================= */
  function renderCheckins() {
    const all = orders.flatMap(o => o.tickets.filter(t => t.checkedIn).map(t => ({ t, email: o.email })))
      .sort((a, b) => new Date(b.t.checkedInAt) - new Date(a.t.checkedInAt)).slice(0, 20);
    let rows = '<tr><th>Zeit</th><th>Ticketcode</th><th>Kategorie</th><th>Event</th><th>E-Mail</th></tr>';
    if (!all.length) rows += '<tr><td colspan="5" style="color:#6f6f6f">Noch keine Check-ins.</td></tr>';
    all.forEach(({ t, email }) => {
      rows += '<tr><td>' + fmtDT(t.checkedInAt) + '</td><td><b>' + esc(t.code) + '</b></td><td>' +
        esc(t.categoryName) + '</td><td>' + esc(t.eventName) + '</td><td>' + esc(email) + '</td></tr>';
    });
    $('checkinTable').innerHTML = rows;
  }

  async function doCheckin() {
    try {
      const res = await S.checkIn($('checkinCode').value);
      msg($('checkinMsg'), '✓ Eingecheckt: ' + res.code + ' – ' + res.category + ' (' + res.email + ')', 'ok');
      $('checkinCode').value = '';
      await renderAll();
    } catch (e) { msg($('checkinMsg'), e.message, 'error'); }
    $('checkinCode').focus();
  }

  /* ================= Admins ================= */
  async function renderAdmins() {
    try {
      const admins = await S.getAdmins();
      const me = S.currentUser();
      $('adminList').innerHTML = admins.map(a =>
        '<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
        '<span style="flex:1">' + esc(a) + (a === me ? ' <span class="hint">(du)</span>' : '') + '</span>' +
        (a !== me ? '<button class="btn btn-danger btn-sm" data-rm="' + esc(a) + '">Entfernen</button>' : '') +
        '</div>').join('');
      $('adminList').querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
        if (confirm(b.dataset.rm + ' als Admin entfernen?')) {
          try { await S.removeAdmin(b.dataset.rm); await renderAdmins(); }
          catch (e) { msg($('adminMsg'), e.message, 'error'); }
        }
      }));
    } catch (e) {
      $('adminList').innerHTML = '<p class="sub">' + esc(e.message) + '</p>';
    }
  }

  /* ================= Gesamt-Render ================= */
  async function renderAll() {
    [orders, events] = await Promise.all([S.allOrders(), S.getEvents(true)]);
    renderStats();
    chartSales();
    chartRevenue();
    renderQuota();
    renderAdminEvents();
    renderOrders();
    renderCheckins();
    renderAdmins();
  }

  /* ================= Init & Events ================= */
  $('btnGateSend').addEventListener('click', gateSend);
  $('adminEmail').addEventListener('keydown', e => { if (e.key === 'Enter') gateSend(); });
  $('btnGateVerify').addEventListener('click', gateVerify);
  $('adminCode').addEventListener('keydown', e => { if (e.key === 'Enter') gateVerify(); });
  $('btnGateBack').addEventListener('click', () => {
    $('gateStep1').style.display = ''; $('gateStep2').style.display = 'none';
  });
  $('adminLogout').addEventListener('click', async e => {
    e.preventDefault(); await S.logout(); location.reload();
  });
  $('orderSearch').addEventListener('input', renderOrders);
  $('orderFilter').addEventListener('change', renderOrders);
  $('btnCheckin').addEventListener('click', doCheckin);
  $('checkinCode').addEventListener('keydown', e => { if (e.key === 'Enter') doCheckin(); });
  $('btnNewEvent').addEventListener('click', () => openEventEditor(null));
  $('btnAddCat').addEventListener('click', () => {
    $('catEditor').insertAdjacentHTML('beforeend', catRowHTML(null));
    bindCatRemove();
  });
  $('btnAddAdmin').addEventListener('click', async () => {
    try {
      await S.addAdmin($('newAdminEmail').value);
      $('newAdminEmail').value = '';
      msg($('adminMsg'), 'Admin hinzugefügt.', 'ok');
      renderAdmins();
    } catch (e) { msg($('adminMsg'), e.message, 'error'); }
  });
  $('btnSaveEvent').addEventListener('click', async () => {
    const cats = Array.from($('catEditor').querySelectorAll('.admin-cat')).map(row => ({
      id: row.dataset.cat || null,
      name: row.querySelector('.c-name').value.trim(),
      price: parseFloat(row.querySelector('.c-price').value) || 0,
      quota: parseInt(row.querySelector('.c-quota').value, 10) || 0,
      maxPerOrder: parseInt(row.querySelector('.c-max').value, 10) || 10,
      description: row.querySelector('.c-desc').value.trim(),
      active: row.querySelector('.c-active').checked
    })).filter(c => c.name);
    const ev = {
      id: $('evId').value || null,
      name: $('evName').value.trim(),
      date: $('evDate').value ? new Date($('evDate').value).toISOString() : null,
      location: $('evLocation').value.trim(),
      description: $('evDesc').value.trim(),
      active: $('evActive').checked,
      categories: cats
    };
    if (!ev.name) { msg($('evMsg'), 'Bitte einen Eventnamen eingeben.', 'error'); return; }
    if (!cats.length) { msg($('evMsg'), 'Bitte mindestens eine Ticketkategorie anlegen.', 'error'); return; }
    try {
      $('btnSaveEvent').disabled = true;
      await S.saveEvent(ev);
      $('eventModal').classList.remove('open');
      await renderAll();
    } catch (e) {
      msg($('evMsg'), e.message, 'error');
    } finally {
      $('btnSaveEvent').disabled = false;
    }
  });
  $('btnCSV').addEventListener('click', () => {
    const blob = new Blob(['﻿' + S.exportOrdersCSV(orders)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ticketshop-bestellungen-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  (async function init() {
    await S.init(); // stellt auch Sessions aus Magic-Link-URLs her
    await enter();
  })();
})();
