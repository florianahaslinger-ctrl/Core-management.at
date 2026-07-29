/* CORE Management Ticketshop – Dashboard-Logik (dashboard.html)
   Backend: Supabase – Anmeldung per E-Mail-Verifizierung, Admin-Rechte über RLS. */
(function () {
  'use strict';
  const S = window.CMStore;
  const $ = id => document.getElementById(id);
  const GOLD = '#B08A28'; // validierte Diagrammfarbe auf dunklem Grund

  let orders = [];   // Cache aller Bestellungen
  let events = [];   // Cache aller Events (inkl. inaktive)
  let myRole = null; // 'super_admin' | 'organizer'
  let mySuper = false;
  let statFilter = ''; // Übersicht: '' = alle Bälle, sonst event.id

  // Gefilterte Sicht für die Übersicht (nach gewähltem Ball)
  function fOrders() { return statFilter ? orders.filter(o => o.eventId === statFilter) : orders; }
  function fEvents() { return statFilter ? events.filter(e => e.id === statFilter) : events; }
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
    // Rolle bestimmen und Head-Admin-only-Bereiche ein-/ausblenden
    myRole = await S.currentRole();
    mySuper = myRole === 'super_admin';
    if (!document.getElementById('roleStyle')) {
      const st = document.createElement('style'); st.id = 'roleStyle';
      st.textContent = 'body:not(.is-super) .super-only{display:none !important}';
      document.head.appendChild(st);
    }
    document.body.classList.toggle('is-super', mySuper);
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
    const st = S.stats(fOrders());
    $('statTiles').innerHTML = [
      ['Umsatz (bezahlt)', S.fmtEUR.format(st.revenue), st.openCount + ' Bestellung(en) offen/abgebrochen'],
      ['Verkaufte Tickets', st.ticketCount, 'über ' + st.orderCount + ' Bestellungen'],
      ['Check-ins', st.checkinCount, st.ticketCount ? Math.round(100 * st.checkinCount / st.ticketCount) + ' % eingecheckt' : '–'],
      ['Zahlungsart', 'Stripe', 'serverseitig bestätigt']
    ].map(t => '<div class="stat-tile"><div class="k">' + t[0] + '</div><div class="v">' + t[1] +
      '</div><div class="s">' + t[2] + '</div></div>').join('');
  }

  function chartSales() {
    const data = S.salesByDay(fOrders(), 14);
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
    const data = S.revenueByCategory(fOrders()).slice(0, 8);
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
    const bar = (pct) => '<td><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;max-width:140px;height:6px;background:rgba(255,255,255,.08);border-radius:3px">' +
      '<div style="width:' + Math.min(100, pct) + '%;height:6px;background:' + GOLD + ';border-radius:3px"></div></div>' +
      '<span style="color:#999;font-size:12px">' + pct + ' %</span></div></td>';
    fEvents().forEach(ev => {
      // Gesamtkontingent: eine Zeile je Event statt je Kategorie.
      if (ev.sharedQuota !== null && ev.sharedQuota !== undefined) {
        const pct = ev.sharedQuota ? Math.round(100 * ev.sharedSold / ev.sharedQuota) : 0;
        rows += '<tr><td>' + esc(ev.name) + '</td><td><em>Alle Kategorien (Gesamtkontingent)</em></td>' +
          '<td>—</td><td>' + ev.sharedSold + '</td><td>' + ev.sharedQuota + '</td>' + bar(pct) + '</tr>';
        return;
      }
      ev.categories.forEach(cat => {
        const pct = cat.quota ? Math.round(100 * cat.sold / cat.quota) : 0;
        rows += '<tr><td>' + esc(ev.name) + '</td><td>' + esc(cat.name) + '</td>' +
          '<td>' + S.fmtEUR.format(cat.price) + '</td><td>' + cat.sold + '</td><td>' + cat.quota + '</td>' + bar(pct) + '</tr>';
      });
    });
    $('quotaTable').innerHTML = rows;
  }

  /* ================= Events & Tickets ================= */
  function renderAdminEvents() {
    $('adminEvents').innerHTML = events.length ? events.map(ev =>
      '<div class="card"><div class="event-head"><h2>' + esc(ev.name) + '</h2>' +
      '<span class="badge ' + (ev.active ? 'bezahlt' : 'storniert') + '">' + (ev.active ? 'aktiv' : 'inaktiv') + '</span>' +
      '<span class="event-meta">' + fmtDT(ev.date) + (ev.location ? ' · ' + esc(ev.location) : '') + '</span></div>' +
      '<div class="table-scroll"><table class="data"><tr><th>Kategorie</th><th>Preis</th><th>Kontingent</th><th>Verkauft</th><th>Status</th></tr>' +
      ev.categories.map(c => '<tr><td>' + esc(c.name) + '</td><td>' + S.fmtEUR.format(c.price) + '</td><td>' +
        ((ev.sharedQuota !== null && ev.sharedQuota !== undefined) ? '<span title="Gesamtkontingent aktiv">—</span>' : c.quota) +
        '</td><td>' + c.sold + '</td><td>' + (c.active ? 'aktiv' : 'inaktiv') + '</td></tr>').join('') +
      '</table></div>' +
      ((ev.sharedQuota !== null && ev.sharedQuota !== undefined)
        ? '<div class="hint" style="margin-top:8px">Gesamtkontingent: <strong>' + ev.sharedQuota + '</strong> Tickets · ' + ev.sharedSold + ' verkauft · ' + ev.sharedRemaining + ' frei</div>'
        : '') +
      '<div class="hint" style="margin-top:10px">Shop-Link: <a href="tickets.html?event=' + ev.id + '" target="_blank" rel="noopener">tickets.html?event=' + ev.id + '</a>' +
        (mySuper ? ' · Veranstalter: ' + (ev.ownerEmail ? esc(ev.ownerEmail) : '— (CORE)') : '') + '</div>' +
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
    c = c || { id: '', name: '', price: '', quota: '', description: '', active: true, maxPerOrder: 10, seating: false };
    return '<div class="admin-cat" data-cat="' + esc(c.id) + '">' +
      '<div style="flex:2 1 160px"><label>Name</label><input type="text" class="c-name" value="' + esc(c.name) + '" placeholder="z. B. VIP"></div>' +
      '<div><label>Preis (€)</label><input type="number" class="c-price" min="0" step="0.5" value="' + esc(c.price) + '"></div>' +
      '<div><label>Kontingent</label><input type="number" class="c-quota" min="0" step="1" value="' + esc(c.quota) + '"></div>' +
      '<div><label>Max./Bestellung</label><input type="number" class="c-max" min="1" step="1" value="' + esc(c.maxPerOrder || 10) + '"></div>' +
      '<div style="flex:2 1 200px"><label>Beschreibung</label><input type="text" class="c-desc" value="' + esc(c.description || '') + '"></div>' +
      '<div style="flex:0 0 auto"><label class="switch" style="margin:0 0 6px"><input type="checkbox" class="c-active"' + (c.active ? ' checked' : '') + '> aktiv</label>' +
      '<label class="switch" style="margin:0 0 8px" title="Nur bei Sitzkarten wählen Kund:innen einen Sitzplatz"><input type="checkbox" class="c-seating"' + (c.seating ? ' checked' : '') + '> Sitzkarte</label>' +
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
    // Gesamtkontingent (modular): NULL = aus, Zahl = an
    const sharedOn = !!(ev && ev.sharedQuota !== null && ev.sharedQuota !== undefined);
    $('evSharedOn').checked = sharedOn;
    $('evSharedQuota').value = sharedOn ? ev.sharedQuota : '';
    updateSharedUI();
    // Gebühren-Modus: false (Standard) = Kunde zahlt Gebühren, true = Veranstalter übernimmt
    $('evFeesOnOrganizer').checked = ev ? !!ev.feesOnOrganizer : false;
    // Veranstalter-Zuweisung (nur Head-Admin)
    if (mySuper) {
      S.getOrganizers().then(list => {
        const orgs = list.filter(a => a.role === 'organizer');
        $('evOwner').innerHTML = '<option value="">— Head-Admin (CORE) —</option>' +
          orgs.map(o => '<option value="' + esc(o.email) + '">' + esc(o.email) + '</option>').join('');
        $('evOwner').value = ev && ev.ownerEmail ? ev.ownerEmail : '';
      }).catch(() => {});
    }
    // Shop-Link (nur bestehende Events)
    const shopBox = $('evShopLink');
    if (ev) {
      const url = location.origin + '/tickets.html?event=' + ev.id;
      $('evShopUrl').value = url; $('evShopOpen').href = url;
      shopBox.style.display = '';
    } else { shopBox.style.display = 'none'; }
    $('catEditor').innerHTML = (ev && ev.categories.length ? ev.categories : [null]).map(catRowHTML).join('');
    bindCatRemove();
    updateSharedUI();
    msg($('evMsg'), '');
    // Sitzplan-Bereich nur bei bestehenden Events
    const box = $('seatPlanBox');
    msg($('seatPlanMsg'), '');
    if (ev) {
      box.style.display = '';
      $('seatPlanInfo').textContent = 'Sitzplan wird geladen …';
      S.seatMap(ev.id).then(seats => {
        const total = seats.length;
        const sold = seats.filter(s => s.status === 'sold').length;
        $('seatPlanInfo').textContent = total
          ? (total + ' Sitzplätze angelegt' + (sold ? ' · ' + sold + ' verkauft' : '') + '.')
          : 'Noch kein Sitzplan angelegt.';
      }).catch(() => { $('seatPlanInfo').textContent = ''; });
    } else {
      box.style.display = 'none';
    }
    $('eventModal').classList.add('open');
  }

  function bindCatRemove() {
    $('catEditor').querySelectorAll('.c-remove').forEach(b => {
      b.onclick = () => b.closest('.admin-cat').remove();
    });
  }

  // Gesamtkontingent-Umschalter: Zahlenfeld zeigen und die pro-Kategorie-Kontingente
  // sichtbar deaktivieren, solange der gemeinsame Topf aktiv ist.
  function updateSharedUI() {
    const on = $('evSharedOn').checked;
    $('evSharedBox').style.display = on ? '' : 'none';
    $('catEditor').querySelectorAll('.c-quota').forEach(inp => {
      inp.disabled = on;
      const wrap = inp.closest('div');
      if (wrap) wrap.style.opacity = on ? '.45' : '';
      inp.title = on ? 'Deaktiviert – dieses Event nutzt ein Gesamtkontingent.' : '';
    });
  }

  /* ================= Sitzplan: Gäste umsetzen ================= */
  let smSource = null; // ausgewählter Quellplatz {id, code, email, label}
  let smSeats = [];    // aktueller Admin-Sitzplan

  function smLabel(s) { return 'Reihe ' + s.row + ' · Tisch ' + s.table + ' · Platz ' + s.seat; }

  function renderSeatEventOptions() {
    const sel = $('smEvent');
    if (!sel) return;
    const prev = sel.value;
    const opts = events.map(ev =>
      '<option value="' + esc(ev.id) + '">' + esc(ev.name) + '</option>');
    sel.innerHTML = opts.length ? opts.join('') : '<option value="">Kein Event vorhanden</option>';
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  async function renderSeatAdmin() {
    const evId = $('smEvent').value;
    const map = $('smMap');
    smSource = null;
    $('smInfo').textContent = '';
    if (!evId) { map.innerHTML = '<p class="sub" style="padding:14px">Kein Event gewählt.</p>'; return; }
    try {
      smSeats = await S.adminSeatMap(evId);
    } catch (e) { msg($('smMsg'), e.message, 'error'); return; }
    if (!smSeats.length) {
      map.innerHTML = '<p class="sub" style="padding:14px">Für dieses Event ist kein Sitzplan angelegt (Events &amp; Tickets → Bearbeiten → Sitzplan).</p>';
      return;
    }
    const occ = smSeats.filter(s => s.status === 'sold').length;
    $('smInfo').textContent = occ + ' von ' + smSeats.length + ' Plätzen belegt. ' +
      (smSource ? '' : 'Belegten Platz anklicken, um einen Gast auszuwählen.');

    const rows = {};
    smSeats.forEach(s => {
      rows[s.row] = rows[s.row] || {};
      rows[s.row][s.table] = rows[s.row][s.table] || [];
      rows[s.row][s.table].push(s);
    });
    map.innerHTML = Object.keys(rows).map(r =>
      '<div class="seat-row"><div class="seat-row-label">Reihe ' + esc(r) + '</div>' +
      '<div class="seat-tables">' + Object.keys(rows[r]).map(t =>
        '<div class="seat-table"><div class="seat-table-label">Tisch ' + esc(t) + '</div>' +
        '<div class="seat-dots">' + rows[r][t].map(s => {
          let cls = 'free', title = smLabel(s) + ' – frei';
          if (s.status === 'sold') {
            cls = 'occupied' + (s.checkedIn ? ' in' : '');
            title = smLabel(s) + ' – ' + (s.email || '') + ' (' + (s.code || '') + ')' + (s.checkedIn ? ' · eingecheckt' : '');
          } else if (s.status === 'held') {
            cls = 'hold'; title = smLabel(s) + ' – gerade im Kauf reserviert';
          }
          if (smSource && smSource.id === s.id) cls += ' src';
          return '<button type="button" class="seat ' + cls + '" data-sid="' + s.id + '" title="' + esc(title) + '">' + s.seat + '</button>';
        }).join('') + '</div></div>').join('') +
      '</div></div>').join('');

    map.querySelectorAll('.seat').forEach(btn => {
      btn.addEventListener('click', () => smClick(btn.dataset.sid));
    });
  }

  async function smClick(seatId) {
    const s = smSeats.find(x => x.id === seatId);
    if (!s) return;
    msg($('smMsg'), '');
    if (!smSource) {
      if (s.status === 'held') { msg($('smMsg'), 'Dieser Platz ist gerade durch einen laufenden Kauf reserviert.', 'error'); return; }
      if (s.status !== 'sold') { $('smInfo').textContent = 'Bitte zuerst einen belegten Platz (Gast) anklicken.'; return; }
      smSource = { id: s.id, code: s.code, email: s.email, label: smLabel(s) };
      $('smInfo').innerHTML = 'Ausgewählt: <b style="color:var(--gold-light)">' + esc(s.email || s.code) + '</b> (' + esc(smSource.label) + ') – jetzt Zielplatz anklicken. <button type="button" class="linklike" id="smCancel">Auswahl aufheben</button>';
      // nur Markierung aktualisieren
      document.querySelectorAll('#smMap .seat.src').forEach(b => b.classList.remove('src'));
      document.querySelector('#smMap .seat[data-sid="' + seatId + '"]').classList.add('src');
      const c = document.getElementById('smCancel');
      if (c) c.addEventListener('click', () => { smSource = null; renderSeatAdmin(); });
      return;
    }
    if (smSource.id === seatId) { smSource = null; renderSeatAdmin(); return; }
    if (s.status === 'held') { msg($('smMsg'), 'Zielplatz ist gerade durch einen laufenden Kauf reserviert.', 'error'); return; }
    const isSwap = s.status === 'sold';
    const confirmText = isSwap
      ? (smSource.email || smSource.code) + ' und ' + (s.email || s.code) + ' tauschen die Plätze?\n' + smSource.label + ' ⇄ ' + smLabel(s)
      : (smSource.email || smSource.code) + ' umsetzen?\n' + smSource.label + ' → ' + smLabel(s);
    if (!confirm(confirmText)) return;
    try {
      const res = await S.moveSeat(smSource.id, seatId);
      msg($('smMsg'), res.action === 'swap'
        ? '✓ Getauscht: ' + res.moved + ' ⇄ ' + res.swapped_with
        : '✓ Umgesetzt: ' + res.moved + ' → ' + smLabel(s), 'ok');
      smSource = null;
      await renderSeatAdmin();
    } catch (e) {
      msg($('smMsg'), e.message, 'error');
    }
  }

  /* ================= Tickets ausstellen ================= */
  function renderIssueOptions() {
    const sel = $('issueCat');
    if (!sel) return;
    const prev = sel.value;
    const opts = [];
    events.forEach(ev => ev.categories.forEach(cat => {
      opts.push('<option value="' + esc(cat.id) + '">' + esc(ev.name) + ' – ' + esc(cat.name) +
        ' (' + S.fmtEUR.format(cat.price) + ', ' + Math.max(0, cat.quota - cat.sold) + ' frei)</option>');
    }));
    sel.innerHTML = opts.length ? opts.join('') : '<option value="">Erst ein Event anlegen …</option>';
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  async function doIssue() {
    const categoryId = $('issueCat').value;
    const qty = parseInt($('issueQty').value, 10) || 0;
    const email = $('issueEmail').value.trim();
    const mode = $('issueMode').value;
    const note = $('issueNote').value.trim();
    if (!categoryId) { msg($('issueMsg'), 'Bitte eine Ticketkategorie wählen.', 'error'); return; }
    if (!email) { msg($('issueMsg'), 'Bitte eine Empfänger-E-Mail eingeben.', 'error'); return; }
    try {
      $('btnIssue').disabled = true;
      msg($('issueMsg'), 'Tickets werden erstellt und gesendet …', 'info');
      const res = await S.issueTickets({ categoryId, qty, email, mode, note });
      msg($('issueMsg'), '✓ ' + res.codes.length + ' Ticket(s) für ' + email +
        (res.emailed ? ' erstellt und per E-Mail gesendet.' : ' erstellt – E-Mail-Versand fehlgeschlagen, bitte Codes manuell weitergeben.'), res.emailed ? 'ok' : 'error');
      $('issueResult').style.display = '';
      $('issueCodes').innerHTML = '<p class="sub">Bestellung ' + esc(res.order_id) + ' · Empfänger ' + esc(email) + '</p>' +
        res.codes.map(c => '<div class="ticket"><div class="tinfo"><div class="tcode">' + esc(c) + '</div>' +
          '<div class="tmeta">core-management.at/ticket.html?c=' + esc(c) + '</div></div></div>').join('');
      $('issueNote').value = '';
      await renderAll();
    } catch (e) {
      msg($('issueMsg'), e.message, 'error');
    } finally {
      $('btnIssue').disabled = false;
    }
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
      msg($('checkinMsg'), '✓ Eingecheckt: ' + res.code + ' – ' + res.category + (res.seat ? ' · ' + res.seat : '') + ' (' + res.email + ')', 'ok');
      $('checkinCode').value = '';
      await renderAll();
    } catch (e) { msg($('checkinMsg'), e.message, 'error'); }
    $('checkinCode').focus();
  }

  /* ---- Kamera-QR-Scanner ---- */
  let scanStream = null;
  let scanTimer = null;
  let scanStart0 = 0;
  let lastScan = { code: '', at: 0 };
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

  // Einen Frame/Bild dekodieren (auf max. Breite skaliert), attemptBoth
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

  async function scanStart() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg($('scanMsg'), 'Dieser Browser unterstützt keinen Live-Kamerazugriff (HTTPS erforderlich). Nutze „Foto scannen“.', 'error');
      return;
    }
    if (!window.jsQR) {
      msg($('scanMsg'), 'Scanner-Bibliothek nicht geladen – bitte Seite neu laden.', 'error');
      return;
    }
    try {
      msg($('scanMsg'), 'Kamera wird gestartet …', 'info');
      try {
        scanStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
        });
      } catch (_) {
        scanStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      // Dauer-Autofokus versuchen (falls die Kamera es unterstützt)
      const track = scanStream.getVideoTracks()[0];
      try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (_) {}

      const video = $('scanVideo');
      video.srcObject = scanStream;
      await video.play();
      $('scannerBox').style.display = '';
      $('btnScanStart').style.display = 'none';
      $('btnScanStop').style.display = '';
      msg($('scanMsg'), 'Scanner aktiv – QR-Code formatfüllend und ruhig ins Bild halten.', 'info');
      scanStart0 = Date.now();

      const loop = async () => {
        if (!scanStream) return;
        if (video.readyState >= 2 && video.videoWidth) {
          let code = null;
          try { code = decode(video, video.videoWidth, video.videoHeight); } catch (_) {}
          const frame = $('scanFrame');
          if (code) {
            if (frame) frame.style.borderColor = 'var(--ok)';
            await scanHit(code);
          } else {
            if (frame) frame.style.borderColor = 'var(--gold)';
            // Hinweis, wenn nach 8 s nichts erkannt wurde
            if (Date.now() - scanStart0 > 8000 && !/eingecheckt|bereits|nicht/i.test($('scanMsg').textContent)) {
              msg($('scanMsg'), 'Noch nichts erkannt: näher heran/scharfstellen, mehr Licht – oder „Foto scannen“ nutzen.', 'info');
            }
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

  async function scanHit(text) {
    const code = S.extractCode(text);
    if (!/^CM-/.test(code)) return; // fremder QR-Code – ignorieren
    const now = Date.now();
    if (code === lastScan.code && now - lastScan.at < 4000) return; // Entprellen
    lastScan = { code, at: now };
    try {
      const res = await S.checkIn(code);
      msg($('scanMsg'), '✓ Eingecheckt: ' + res.code + ' – ' + res.category + (res.seat ? ' · ' + res.seat : '') + ' (' + res.email + ')', 'ok');
      if (navigator.vibrate) navigator.vibrate(120);
      renderAll();
    } catch (e) {
      msg($('scanMsg'), code + ': ' + e.message, 'error');
      if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
    }
  }

  function scanStop() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    $('scannerBox').style.display = 'none';
    $('btnScanStart').style.display = '';
    $('btnScanStop').style.display = 'none';
  }

  // Foto-Alternative: aufgenommenes/gewähltes Bild dekodieren
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

  /* ================= Admins ================= */
  async function renderAdmins() {
    if (!mySuper) { $('adminList').innerHTML = ''; return; }
    try {
      const list = await S.getOrganizers(); // [{email, role}]
      const me = S.currentUser();
      $('adminList').innerHTML = list.map(a =>
        '<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
        '<span style="flex:1">' + esc(a.email) + (a.email === me ? ' <span class="hint">(du)</span>' : '') +
          ' <span class="badge ' + (a.role === 'super_admin' ? 'bezahlt' : 'offen') + '" style="margin-left:6px">' +
          (a.role === 'super_admin' ? 'Head-Admin' : 'Veranstalter') + '</span></span>' +
        (a.email !== me && a.role !== 'super_admin' ? '<button class="btn btn-danger btn-sm" data-rm="' + esc(a.email) + '">Entfernen</button>' : '') +
        '</div>').join('');
      $('adminList').querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
        if (confirm(b.dataset.rm + ' als Veranstalter entfernen?')) {
          try { await S.removeOrganizer(b.dataset.rm); await renderAdmins(); }
          catch (e) { msg($('adminMsg'), e.message, 'error'); }
        }
      }));
    } catch (e) {
      $('adminList').innerHTML = '<p class="sub">' + esc(e.message) + '</p>';
    }
  }

  function renderOverview() { renderStats(); chartSales(); chartRevenue(); renderQuota(); }
  function populateStatEvents() {
    const sel = $('statEvent'); if (!sel) return;
    sel.innerHTML = '<option value="">Alle Bälle (gesamt)</option>' +
      events.map(e => '<option value="' + e.id + '">' + esc(e.name) + '</option>').join('');
    if (!events.some(e => e.id === statFilter)) statFilter = '';
    sel.value = statFilter;
  }

  /* ================= Stripe Connect (Auszahlung) ================= */
  async function renderConnect() {
    const body = $('connectBody');
    if (!body) return;
    if (mySuper) {
      body.innerHTML = '<p class="sub">Du bist Head-Admin. Zahlungen für CORE-eigene Bälle laufen direkt über das Plattform-Konto. ' +
        'Zugewiesene Veranstalter verbinden ihr eigenes Auszahlungskonto hier selbst – ihre Einnahmen fließen direkt an sie, deine Gebühr (3,5 % + 0,25 €/Ticket) bleibt automatisch bei CORE.</p>';
      return;
    }
    body.innerHTML = '<p class="sub">Status wird geprüft …</p>';
    try {
      const st = await S.connectStatus();
      if (st.chargesEnabled) {
        body.innerHTML = '<p class="sub" style="color:var(--gold-light)">✓ Dein Stripe-Konto ist verbunden. Die Ticket-Einnahmen deiner Bälle werden direkt an dich ausgezahlt (abzüglich Service- & Zahlungsgebühr).</p>';
      } else {
        body.innerHTML = '<p class="sub">' + (st.hasAccount
          ? 'Dein Stripe-Konto ist angelegt, aber die Einrichtung ist noch nicht abgeschlossen. Ohne abgeschlossene Einrichtung kann dein Ball keine Tickets verkaufen.'
          : 'Verbinde dein Stripe-Konto, damit die Ticket-Einnahmen deiner Bälle direkt an dich ausgezahlt werden. Erst danach kann dein Ball Tickets verkaufen.') +
          '</p><button class="btn btn-gold btn-sm" id="btnConnect">' + (st.hasAccount ? 'Einrichtung fortsetzen' : 'Mit Stripe verbinden') + '</button>' +
          '<div class="msg" id="connectMsg"></div>';
        $('btnConnect').addEventListener('click', async () => {
          const b = $('btnConnect'); b.disabled = true; b.textContent = 'Weiterleiten …';
          try { const r = await S.connectLink(); location.href = r.url; }
          catch (e) { b.disabled = false; msg($('connectMsg'), e.message, 'error'); }
        });
      }
    } catch (e) {
      body.innerHTML = '<p class="sub">' + esc(e.message) + '</p>';
    }
  }

  /* ================= Gesamt-Render ================= */
  async function renderAll() {
    [orders, events] = await Promise.all([S.allOrders(), S.getManagedEvents(true)]);
    populateStatEvents();
    renderStats();
    chartSales();
    chartRevenue();
    renderQuota();
    renderAdminEvents();
    renderIssueOptions();
    renderSeatEventOptions();
    renderSeatAdmin();
    renderOrders();
    renderCheckins();
    renderAdmins();
    renderConnect();
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
  $('statEvent').addEventListener('change', () => { statFilter = $('statEvent').value; renderOverview(); });
  $('orderSearch').addEventListener('input', renderOrders);
  $('orderFilter').addEventListener('change', renderOrders);
  $('btnCheckin').addEventListener('click', doCheckin);
  $('checkinCode').addEventListener('keydown', e => { if (e.key === 'Enter') doCheckin(); });
  $('btnGenSeats').addEventListener('click', async () => {
    const id = $('evId').value;
    if (!id) { msg($('seatPlanMsg'), 'Bitte das Event zuerst speichern.', 'error'); return; }
    try {
      $('btnGenSeats').disabled = true;
      const existing = await S.seatMap(id);
      if (existing.length) {
        if (existing.some(s => s.status === 'sold')) { msg($('seatPlanMsg'), 'Es sind bereits Plätze verkauft – Plan kann nicht neu erstellt werden.', 'error'); return; }
        if (!confirm('Es existiert bereits ein Sitzplan (' + existing.length + ' Plätze). Neu erstellen und alten ersetzen?')) return;
        await S.clearSeats(id);
      }
      const n = await S.generateSeats(id, $('spRows').value, $('spTables').value, $('spSeats').value);
      msg($('seatPlanMsg'), '✓ Sitzplan mit ' + n + ' Plätzen erstellt.', 'ok');
      $('seatPlanInfo').textContent = n + ' Sitzplätze angelegt.';
    } catch (e) { msg($('seatPlanMsg'), e.message, 'error'); }
    finally { $('btnGenSeats').disabled = false; }
  });
  $('btnClearSeats').addEventListener('click', async () => {
    const id = $('evId').value;
    if (!id) return;
    if (!confirm('Sitzplan wirklich leeren?')) return;
    try {
      await S.clearSeats(id);
      msg($('seatPlanMsg'), 'Sitzplan geleert.', 'ok');
      $('seatPlanInfo').textContent = 'Noch kein Sitzplan angelegt.';
    } catch (e) { msg($('seatPlanMsg'), e.message, 'error'); }
  });
  $('smEvent').addEventListener('change', renderSeatAdmin);
  $('btnSmReload').addEventListener('click', renderSeatAdmin);
  $('btnIssue').addEventListener('click', doIssue);
  $('btnScanStart').addEventListener('click', scanStart);
  $('btnScanStop').addEventListener('click', scanStop);
  $('btnScanPhoto').addEventListener('click', () => $('scanPhoto').click());
  $('scanPhoto').addEventListener('change', e => { scanPhoto(e.target.files[0]); e.target.value = ''; });
  $('btnNewEvent').addEventListener('click', () => openEventEditor(null));
  $('btnAddCat').addEventListener('click', () => {
    $('catEditor').insertAdjacentHTML('beforeend', catRowHTML(null));
    bindCatRemove();
    updateSharedUI();
  });
  $('evSharedOn').addEventListener('change', updateSharedUI);
  $('btnAddAdmin').addEventListener('click', async () => {
    try {
      await S.addOrganizer($('newAdminEmail').value);
      $('newAdminEmail').value = '';
      msg($('adminMsg'), 'Veranstalter hinzugefügt. Weise ihm nun beim Event unter „Bearbeiten → Veranstalter" einen Ball zu.', 'ok');
      renderAdmins();
    } catch (e) { msg($('adminMsg'), e.message, 'error'); }
  });
  $('btnCopyShop').addEventListener('click', () => {
    const inp = $('evShopUrl'); inp.select();
    const done = () => { $('btnCopyShop').textContent = '✓ Kopiert'; setTimeout(() => $('btnCopyShop').textContent = 'Kopieren', 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(inp.value).then(done).catch(() => { document.execCommand('copy'); done(); });
    else { document.execCommand('copy'); done(); }
  });
  $('btnSaveEvent').addEventListener('click', async () => {
    const cats = Array.from($('catEditor').querySelectorAll('.admin-cat')).map(row => ({
      id: row.dataset.cat || null,
      name: row.querySelector('.c-name').value.trim(),
      price: parseFloat(row.querySelector('.c-price').value) || 0,
      quota: parseInt(row.querySelector('.c-quota').value, 10) || 0,
      maxPerOrder: parseInt(row.querySelector('.c-max').value, 10) || 10,
      description: row.querySelector('.c-desc').value.trim(),
      active: row.querySelector('.c-active').checked,
      seating: row.querySelector('.c-seating').checked
    })).filter(c => c.name);
    if (cats.filter(c => c.seating).length > 1) {
      msg($('evMsg'), 'Es kann nur eine Kategorie als Sitzkarte markiert sein.', 'error'); return;
    }
    const ev = {
      id: $('evId').value || null,
      name: $('evName').value.trim(),
      date: $('evDate').value ? new Date($('evDate').value).toISOString() : null,
      location: $('evLocation').value.trim(),
      description: $('evDesc').value.trim(),
      active: $('evActive').checked,
      sharedQuota: $('evSharedOn').checked ? (parseInt($('evSharedQuota').value, 10) || 0) : null,
      feesOnOrganizer: $('evFeesOnOrganizer').checked,
      categories: cats
    };
    // Besitzer/Veranstalter zuweisen
    if (mySuper) ev.ownerEmail = $('evOwner').value || null;
    else if (!ev.id) ev.ownerEmail = S.currentUser(); // Veranstalter legt eigenen Ball an
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
