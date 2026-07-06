/* =========================================================
   CORE Management Ticketshop – Datenschicht (store.js)
   Speicherung: localStorage (statisches Hosting, GitHub Pages)
   E-Mail-Versand: EmailJS (konfigurierbar im Dashboard) oder Demo-Modus
   ========================================================= */
(function (global) {
  'use strict';

  const KEYS = {
    events:   'cm_shop_events',
    orders:   'cm_shop_orders',
    users:    'cm_shop_users',
    settings: 'cm_shop_settings',
    codes:    'cm_shop_codes',
    session:  'cm_shop_session',
    admin:    'cm_shop_admin_session',
    checkins: 'cm_shop_checkins'
  };

  /* ---------- Hilfsfunktionen ---------- */

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function ticketCode() {
    // Menschenlesbarer Ticketcode, z. B. CM-K7F3-9Q2D
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const block = n => Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map(x => chars[x % chars.length]).join('');
    return 'CM-' + block(4) + '-' + block(4);
  }

  function normEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(email));
  }

  const fmtEUR = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });

  /* ---------- Standard-Einstellungen & Demo-Daten ---------- */

  const DEFAULT_SETTINGS = {
    shopName: 'CORE Management Ticketshop',
    // PIN "2468" – im Dashboard änderbar (Hash von "2468")
    adminPinHash: '3be88563e740fdd0650287bd91e0eb8691bfdef1d3efdebe3bcf05e0dba4c4dc',
    emailjs: { serviceId: '', templateId: '', publicKey: '' },
    checkoutNote: 'Die Tickets sind verbindlich reserviert. Zahlungsdetails erhaltet ihr per E-Mail bzw. an der Abendkassa.',
    codeTtlMin: 10,
    maxPerOrder: 10
  };

  function seedEvents() {
    return [
      {
        id: uid('ev'),
        name: 'Schulball 2026 – Grand Opening',
        date: '2026-11-14T20:00',
        location: 'Palais Eventsaal, Wien',
        description: 'Der große Ball des Jahres – Live-Band, DJ, Mitternachtseinlage.',
        active: true,
        categories: [
          { id: uid('cat'), name: 'Standard', price: 25, quota: 400, description: 'Regulärer Balleintritt', active: true, maxPerOrder: 10 },
          { id: uid('cat'), name: 'VIP', price: 59, quota: 60, description: 'VIP-Bereich, Welcome-Drink, eigene Garderobe', active: true, maxPerOrder: 6 },
          { id: uid('cat'), name: 'Schüler:innen ermäßigt', price: 18, quota: 250, description: 'Nur mit gültigem Schülerausweis', active: true, maxPerOrder: 10 }
        ]
      }
    ];
  }

  /* ---------- Store-API ---------- */

  const Store = {
    KEYS, uid, sha256, fmtEUR, validEmail, normEmail,

    /* --- Einstellungen --- */
    getSettings() {
      const s = load(KEYS.settings, null);
      return Object.assign({}, DEFAULT_SETTINGS, s || {},
        { emailjs: Object.assign({}, DEFAULT_SETTINGS.emailjs, (s && s.emailjs) || {}) });
    },
    saveSettings(patch) {
      const s = Object.assign(this.getSettings(), patch);
      save(KEYS.settings, s);
      return s;
    },
    emailConfigured() {
      const e = this.getSettings().emailjs;
      return !!(e.serviceId && e.templateId && e.publicKey);
    },

    /* --- Events / Ticketkategorien (modular) --- */
    getEvents() {
      let evs = load(KEYS.events, null);
      if (!evs) { evs = seedEvents(); save(KEYS.events, evs); }
      return evs;
    },
    saveEvents(evs) { save(KEYS.events, evs); },
    getEvent(id) { return this.getEvents().find(e => e.id === id) || null; },
    upsertEvent(ev) {
      const evs = this.getEvents();
      const i = evs.findIndex(e => e.id === ev.id);
      if (i >= 0) evs[i] = ev; else { ev.id = ev.id || uid('ev'); evs.push(ev); }
      save(KEYS.events, evs);
      return ev;
    },
    deleteEvent(id) {
      save(KEYS.events, this.getEvents().filter(e => e.id !== id));
    },
    soldByCategory() {
      // Verkaufte Stückzahlen je Kategorie aus nicht-stornierten Bestellungen
      const sold = {};
      this.getOrders().forEach(o => {
        if (o.status === 'storniert') return;
        o.items.forEach(it => { sold[it.categoryId] = (sold[it.categoryId] || 0) + it.qty; });
      });
      return sold;
    },
    remaining(ev, cat) {
      const sold = this.soldByCategory()[cat.id] || 0;
      return Math.max(0, (cat.quota || 0) - sold);
    },

    /* --- Nutzer & E-Mail-Verifizierung --- */
    getUsers() { return load(KEYS.users, []); },
    saveUsers(u) { save(KEYS.users, u); },

    async requestCode(email) {
      email = normEmail(email);
      if (!validEmail(email)) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
      const codes = load(KEYS.codes, {});
      const now = Date.now();
      const prev = codes[email];
      if (prev && prev.sentAt && now - prev.sentAt < 60 * 1000) {
        throw new Error('Bitte kurz warten – ein Code wurde gerade erst gesendet (60 s Sperre).');
      }
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const ttl = this.getSettings().codeTtlMin * 60 * 1000;
      codes[email] = { hash: await sha256(email + ':' + code), expiresAt: now + ttl, attempts: 0, sentAt: now };
      save(KEYS.codes, codes);

      if (this.emailConfigured()) {
        await this.sendEmail(email, {
          subject: 'Dein Verifizierungscode – CORE Management',
          passcode: code,
          message: 'Dein Verifizierungscode lautet: ' + code +
            ' (gültig für ' + this.getSettings().codeTtlMin + ' Minuten).'
        });
        return { demo: false };
      }
      // Demo-Modus: kein E-Mail-Dienst konfiguriert – Code wird angezeigt
      return { demo: true, code };
    },

    async verifyCode(email, code) {
      email = normEmail(email);
      const codes = load(KEYS.codes, {});
      const entry = codes[email];
      if (!entry) throw new Error('Kein Code angefordert. Bitte zuerst einen Code anfordern.');
      if (Date.now() > entry.expiresAt) { delete codes[email]; save(KEYS.codes, codes); throw new Error('Der Code ist abgelaufen. Bitte neuen Code anfordern.'); }
      if (entry.attempts >= 5) { delete codes[email]; save(KEYS.codes, codes); throw new Error('Zu viele Fehlversuche. Bitte neuen Code anfordern.'); }
      const ok = (await sha256(email + ':' + String(code).trim())) === entry.hash;
      if (!ok) {
        entry.attempts++; save(KEYS.codes, codes);
        throw new Error('Falscher Code (' + (5 - entry.attempts) + ' Versuche übrig).');
      }
      delete codes[email]; save(KEYS.codes, codes);
      const users = this.getUsers();
      let u = users.find(x => x.email === email);
      if (!u) { u = { email, createdAt: new Date().toISOString() }; users.push(u); }
      u.lastLogin = new Date().toISOString();
      this.saveUsers(users);
      save(KEYS.session, { email, since: Date.now() });
      return u;
    },

    currentUser() {
      const s = load(KEYS.session, null);
      return s ? s.email : null;
    },
    logout() { localStorage.removeItem(KEYS.session); },

    async sendEmail(toEmail, params) {
      const { serviceId, templateId, publicKey } = this.getSettings().emailjs;
      const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: serviceId,
          template_id: templateId,
          user_id: publicKey,
          template_params: Object.assign({ to_email: toEmail, email: toEmail }, params)
        })
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error('E-Mail-Versand fehlgeschlagen (' + res.status + '). ' + txt);
      }
    },

    /* --- Bestellungen & Tickets --- */
    getOrders() { return load(KEYS.orders, []); },
    saveOrders(o) { save(KEYS.orders, o); },

    placeOrder(email, cartItems) {
      // cartItems: [{eventId, categoryId, qty}]
      email = normEmail(email);
      if (!email) throw new Error('Bitte zuerst mit E-Mail anmelden.');
      const evs = this.getEvents();
      const sold = this.soldByCategory();
      const items = [];
      let total = 0;
      for (const ci of cartItems) {
        const ev = evs.find(e => e.id === ci.eventId);
        const cat = ev && ev.categories.find(c => c.id === ci.categoryId);
        if (!ev || !cat || !ev.active || !cat.active) throw new Error('Eine Ticketkategorie ist nicht mehr verfügbar.');
        const rest = Math.max(0, (cat.quota || 0) - (sold[cat.id] || 0));
        if (ci.qty > rest) throw new Error('Für „' + cat.name + '“ sind nur noch ' + rest + ' Tickets verfügbar.');
        items.push({
          eventId: ev.id, eventName: ev.name, eventDate: ev.date, eventLocation: ev.location,
          categoryId: cat.id, categoryName: cat.name, price: cat.price, qty: ci.qty
        });
        total += cat.price * ci.qty;
      }
      if (!items.length) throw new Error('Der Warenkorb ist leer.');

      const tickets = [];
      items.forEach(it => {
        for (let i = 0; i < it.qty; i++) {
          tickets.push({
            code: ticketCode(), eventId: it.eventId, eventName: it.eventName,
            eventDate: it.eventDate, eventLocation: it.eventLocation,
            categoryId: it.categoryId, categoryName: it.categoryName, price: it.price,
            checkedIn: false, checkedInAt: null
          });
        }
      });

      const order = {
        id: 'B' + Date.now().toString().slice(-8),
        email, createdAt: new Date().toISOString(),
        items, tickets, total, status: 'offen'
      };
      const orders = this.getOrders();
      orders.push(order);
      this.saveOrders(orders);

      // Bestellbestätigung senden (best effort)
      if (this.emailConfigured()) {
        const list = items.map(i => i.qty + '× ' + i.categoryName + ' – ' + i.eventName).join(', ');
        this.sendEmail(email, {
          subject: 'Reservierungsbestätigung ' + order.id + ' – CORE Management',
          passcode: order.id,
          message: 'Danke für deine Bestellung ' + order.id + ': ' + list +
            '. Gesamt: ' + fmtEUR.format(total) +
            '. Die Tickets sind reserviert und werden nach Zahlungseingang gültig – ' +
            'danach findest du sie inklusive QR-Code und PDF unter „Meine Tickets“. ' +
            this.getSettings().checkoutNote
        }).catch(() => {});
      }
      return order;
    },

    ordersForUser(email) {
      email = normEmail(email);
      return this.getOrders().filter(o => o.email === email);
    },

    setOrderStatus(orderId, status) {
      const orders = this.getOrders();
      const o = orders.find(x => x.id === orderId);
      if (o) {
        const wasPaid = o.status === 'bezahlt';
        o.status = status;
        this.saveOrders(orders);
        // Zahlungsbestätigung senden (best effort)
        if (status === 'bezahlt' && !wasPaid && this.emailConfigured()) {
          this.sendEmail(o.email, {
            subject: 'Zahlung erhalten – deine Tickets sind gültig (' + o.id + ')',
            passcode: o.id,
            message: 'Wir haben deine Zahlung für Bestellung ' + o.id + ' erhalten. ' +
              'Deine Tickets sind jetzt gültig: ' + o.tickets.map(t => t.code).join(', ') +
              '. Unter „Meine Tickets“ auf core-management.at/tickets.html kannst du sie ' +
              'inklusive QR-Code ansehen und als PDF herunterladen.'
          }).catch(() => {});
        }
      }
      return o;
    },

    /* --- Check-in --- */
    findTicket(code) {
      code = String(code || '').trim().toUpperCase();
      for (const o of this.getOrders()) {
        const t = o.tickets.find(t => t.code === code);
        if (t) return { order: o, ticket: t };
      }
      return null;
    },
    checkIn(code) {
      const found = this.findTicket(code);
      if (!found) throw new Error('Ticketcode nicht gefunden.');
      if (found.order.status === 'storniert') throw new Error('Bestellung wurde storniert – Ticket ungültig.');
      if (found.order.status !== 'bezahlt') throw new Error('Bestellung ' + found.order.id +
        ' ist noch nicht bezahlt – Ticket nicht gültig. Zuerst unter „Bestellungen“ als bezahlt markieren.');
      if (found.ticket.checkedIn) throw new Error('Ticket wurde bereits eingecheckt (' +
        new Date(found.ticket.checkedInAt).toLocaleString('de-AT') + ').');
      found.ticket.checkedIn = true;
      found.ticket.checkedInAt = new Date().toISOString();
      this.saveOrders(this.getOrders().map(o => o.id === found.order.id ? found.order : o));
      return found;
    },

    /* --- Admin-Session --- */
    async adminLogin(pin) {
      const hash = await sha256('cm-admin:' + String(pin).trim());
      if (hash !== this.getSettings().adminPinHash) throw new Error('Falsche PIN.');
      sessionStorage.setItem(KEYS.admin, '1');
      return true;
    },
    adminLoggedIn() { return sessionStorage.getItem(KEYS.admin) === '1'; },
    adminLogout() { sessionStorage.removeItem(KEYS.admin); },
    async setAdminPin(pin) {
      pin = String(pin).trim();
      if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN muss 4–8 Ziffern haben.');
      this.saveSettings({ adminPinHash: await sha256('cm-admin:' + pin) });
    },

    /* --- Statistiken --- */
    stats() {
      const orders = this.getOrders().filter(o => o.status !== 'storniert');
      const tickets = orders.flatMap(o => o.tickets);
      return {
        revenue: orders.reduce((s, o) => s + o.total, 0),
        orderCount: orders.length,
        ticketCount: tickets.length,
        checkinCount: tickets.filter(t => t.checkedIn).length,
        openCount: this.getOrders().filter(o => o.status === 'offen').length,
        userCount: this.getUsers().length
      };
    },

    salesByDay(days) {
      // Tickets pro Tag der letzten N Tage
      const out = [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        out.push({ date: d, label: d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' }), qty: 0, revenue: 0 });
      }
      this.getOrders().forEach(o => {
        if (o.status === 'storniert') return;
        const od = new Date(o.createdAt); od.setHours(0, 0, 0, 0);
        const slot = out.find(x => x.date.getTime() === od.getTime());
        if (slot) { slot.qty += o.tickets.length; slot.revenue += o.total; }
      });
      return out;
    },

    revenueByCategory() {
      const map = {};
      this.getOrders().forEach(o => {
        if (o.status === 'storniert') return;
        o.items.forEach(it => {
          const key = it.categoryName + ' · ' + it.eventName;
          if (!map[key]) map[key] = { label: it.categoryName, event: it.eventName, revenue: 0, qty: 0 };
          map[key].revenue += it.price * it.qty;
          map[key].qty += it.qty;
        });
      });
      return Object.values(map).sort((a, b) => b.revenue - a.revenue);
    },

    exportOrdersCSV() {
      const rows = [['Bestellung', 'Datum', 'E-Mail', 'Status', 'Ticketcode', 'Event', 'Kategorie', 'Preis', 'Check-in']];
      this.getOrders().forEach(o => {
        o.tickets.forEach(t => {
          rows.push([o.id, o.createdAt, o.email, o.status, t.code, t.eventName, t.categoryName,
            String(t.price).replace('.', ','), t.checkedIn ? t.checkedInAt : '']);
        });
      });
      return rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(';')).join('\r\n');
    }
  };

  global.CMStore = Store;
})(window);
