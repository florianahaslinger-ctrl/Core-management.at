/* =========================================================
   CORE Management Ticketshop – Datenschicht (store.js)

   Zwei Betriebsarten mit identischer (asynchroner) API:
   - Backend-Modus:  Supabase (Datenbank, E-Mail-Codes, Stripe
     über Edge Functions) – aktiv, sobald assets/config.js
     supabaseUrl + supabaseAnonKey enthält.
   - Lokaler Modus:  localStorage + EmailJS/Demo-Codes –
     Fallback ohne Backend.
   ========================================================= */
(function (global) {
  'use strict';

  /* ================= gemeinsame Hilfsfunktionen ================= */

  const KEYS = {
    events:   'cm_shop_events',
    orders:   'cm_shop_orders',
    users:    'cm_shop_users',
    settings: 'cm_shop_settings',
    codes:    'cm_shop_codes',
    session:  'cm_shop_session',
    pending:  'cm_shop_pending_payment',
    admin:    'cm_shop_admin_session'
  };

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function ticketCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const block = n => Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map(x => chars[x % chars.length]).join('');
    return 'CM-' + block(4) + '-' + block(4);
  }

  function normEmail(email) { return String(email || '').trim().toLowerCase(); }
  function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(email)); }

  const fmtEUR = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });

  /* ---- gemeinsame Auswertungen (arbeiten auf Bestell-Arrays) ---- */

  function computeStats(orders, userCount) {
    const ok = orders.filter(o => o.status !== 'storniert');
    const tickets = ok.flatMap(o => o.tickets);
    return {
      revenue: ok.filter(o => o.status === 'bezahlt').reduce((s, o) => s + o.total, 0),
      orderCount: ok.length,
      ticketCount: tickets.length,
      checkinCount: tickets.filter(t => t.checkedIn).length,
      openCount: orders.filter(o => o.status === 'offen').length,
      userCount: userCount != null ? userCount : new Set(orders.map(o => o.email)).size
    };
  }

  function computeSalesByDay(orders, days) {
    const out = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      out.push({ date: d, label: d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' }), qty: 0, revenue: 0 });
    }
    orders.forEach(o => {
      if (o.status === 'storniert') return;
      const od = new Date(o.createdAt); od.setHours(0, 0, 0, 0);
      const slot = out.find(x => x.date.getTime() === od.getTime());
      if (slot) { slot.qty += o.tickets.length; slot.revenue += o.total; }
    });
    return out;
  }

  function computeRevenueByCategory(orders) {
    const map = {};
    orders.forEach(o => {
      if (o.status === 'storniert') return;
      o.items.forEach(it => {
        const key = it.categoryName + ' · ' + it.eventName;
        if (!map[key]) map[key] = { label: it.categoryName, event: it.eventName, revenue: 0, qty: 0 };
        map[key].revenue += it.price * it.qty;
        map[key].qty += it.qty;
      });
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }

  function computeSold(orders) {
    const sold = {};
    orders.forEach(o => {
      if (o.status === 'storniert') return;
      o.items.forEach(it => { sold[it.categoryId] = (sold[it.categoryId] || 0) + it.qty; });
    });
    return sold;
  }

  function exportCSV(orders) {
    const rows = [['Bestellung', 'Datum', 'E-Mail', 'Status', 'Zahlungsart', 'Ticketcode', 'Event', 'Kategorie', 'Preis', 'Check-in']];
    orders.forEach(o => {
      o.tickets.forEach(t => {
        rows.push([o.id, o.createdAt, o.email, o.status, o.paidVia || '', t.code, t.eventName, t.categoryName,
          String(t.price).replace('.', ','), t.checkedIn ? t.checkedInAt : '']);
      });
    });
    return rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(';')).join('\r\n');
  }

  function remainingOf(cat, sold) {
    return Math.max(0, (cat.quota || 0) - (sold[cat.id] || 0));
  }

  /* ================= Lokaler Modus (localStorage) ================= */

  const DEFAULT_SETTINGS = {
    shopName: 'CORE Management Ticketshop',
    adminPinHash: '3be88563e740fdd0650287bd91e0eb8691bfdef1d3efdebe3bcf05e0dba4c4dc', // PIN 2468
    emailjs: { serviceId: '', templateId: '', publicKey: '' },
    checkoutNote: 'Die Tickets sind verbindlich reserviert. Zahlungsdetails erhaltet ihr per E-Mail bzw. an der Abendkassa.',
    codeTtlMin: 10,
    maxPerOrder: 10
  };

  function seedEvents() {
    return [{
      id: uid('ev'),
      name: 'Schulball 2026 – Grand Opening',
      date: '2026-11-14T20:00',
      location: 'Palais Eventsaal, Wien',
      description: 'Der große Ball des Jahres – Live-Band, DJ, Mitternachtseinlage.',
      active: true,
      categories: [
        { id: uid('cat'), name: 'Standard', price: 25, quota: 400, description: 'Regulärer Balleintritt', active: true, maxPerOrder: 10, paymentLink: '' },
        { id: uid('cat'), name: 'VIP', price: 59, quota: 60, description: 'VIP-Bereich, Welcome-Drink, eigene Garderobe', active: true, maxPerOrder: 6, paymentLink: '' },
        { id: uid('cat'), name: 'Schüler:innen ermäßigt', price: 18, quota: 250, description: 'Nur mit gültigem Schülerausweis', active: true, maxPerOrder: 10, paymentLink: '' }
      ]
    }];
  }

  const Local = {
    remote: false,

    async init() {},

    /* --- Einstellungen --- */
    async getSettings() {
      const s = load(KEYS.settings, null);
      return Object.assign({}, DEFAULT_SETTINGS, s || {},
        { emailjs: Object.assign({}, DEFAULT_SETTINGS.emailjs, (s && s.emailjs) || {}) });
    },
    async saveSettings(patch) {
      const s = Object.assign(await this.getSettings(), patch);
      save(KEYS.settings, s);
      return s;
    },
    async emailConfigured() {
      const e = (await this.getSettings()).emailjs;
      return !!(e.serviceId && e.templateId && e.publicKey);
    },

    /* --- Events --- */
    async getEvents() {
      let evs = load(KEYS.events, null);
      if (!evs) { evs = seedEvents(); save(KEYS.events, evs); }
      return evs;
    },
    async getEvent(id) { return (await this.getEvents()).find(e => e.id === id) || null; },
    async upsertEvent(ev) {
      const evs = await this.getEvents();
      const i = evs.findIndex(e => e.id === ev.id);
      if (i >= 0) evs[i] = ev; else { ev.id = ev.id || uid('ev'); evs.push(ev); }
      save(KEYS.events, evs);
      return ev;
    },
    async deleteEvent(id) {
      save(KEYS.events, (await this.getEvents()).filter(e => e.id !== id));
    },
    async soldByCategory() { return computeSold(load(KEYS.orders, [])); },

    /* --- Login / Verifizierung (EmailJS oder Demo) --- */
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
      const settings = await this.getSettings();
      codes[email] = { hash: await sha256(email + ':' + code), expiresAt: now + settings.codeTtlMin * 60000, attempts: 0, sentAt: now };
      save(KEYS.codes, codes);
      if (await this.emailConfigured()) {
        await this.sendEmail(email, {
          subject: 'Dein Verifizierungscode – CORE Management',
          passcode: code,
          message: 'Dein Verifizierungscode lautet: ' + code + ' (gültig für ' + settings.codeTtlMin + ' Minuten).'
        });
        return { demo: false };
      }
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
      const users = load(KEYS.users, []);
      let u = users.find(x => x.email === email);
      if (!u) { u = { email, createdAt: new Date().toISOString() }; users.push(u); }
      u.lastLogin = new Date().toISOString();
      save(KEYS.users, users);
      save(KEYS.session, { email, since: Date.now() });
      return u;
    },

    currentUser() {
      const s = load(KEYS.session, null);
      return s ? s.email : null;
    },
    async logout() { localStorage.removeItem(KEYS.session); },

    async sendEmail(toEmail, params) {
      const { serviceId, templateId, publicKey } = (await this.getSettings()).emailjs;
      const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: serviceId, template_id: templateId, user_id: publicKey,
          template_params: Object.assign({ to_email: toEmail, email: toEmail }, params)
        })
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error('E-Mail-Versand fehlgeschlagen (' + res.status + '). ' + txt);
      }
    },

    /* --- Bestellungen --- */
    async placeOrder(cartItems) {
      const email = this.currentUser();
      if (!email) throw new Error('Bitte zuerst mit E-Mail anmelden.');
      const evs = await this.getEvents();
      const sold = await this.soldByCategory();
      const items = [];
      let total = 0;
      for (const ci of cartItems) {
        const ev = evs.find(e => e.id === ci.eventId);
        const cat = ev && ev.categories.find(c => c.id === ci.categoryId);
        if (!ev || !cat || !ev.active || !cat.active) throw new Error('Eine Ticketkategorie ist nicht mehr verfügbar.');
        const rest = remainingOf(cat, sold);
        if (ci.qty > rest) throw new Error('Für „' + cat.name + '“ sind nur noch ' + rest + ' Tickets verfügbar.');
        items.push({
          eventId: ev.id, eventName: ev.name, eventDate: ev.date, eventLocation: ev.location,
          categoryId: cat.id, categoryName: cat.name, price: cat.price, qty: ci.qty,
          paymentLink: cat.paymentLink || ''
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
      const orders = load(KEYS.orders, []);
      orders.push(order);
      save(KEYS.orders, orders);

      if (await this.emailConfigured()) {
        const list = items.map(i => i.qty + '× ' + i.categoryName + ' – ' + i.eventName).join(', ');
        this.sendEmail(email, {
          subject: 'Reservierungsbestätigung ' + order.id + ' – CORE Management',
          passcode: order.id,
          message: 'Danke für deine Bestellung ' + order.id + ': ' + list +
            '. Gesamt: ' + fmtEUR.format(total) +
            '. Die Tickets sind reserviert und werden nach Zahlungseingang gültig. ' +
            (await this.getSettings()).checkoutNote
        }).catch(() => {});
      }

      // Online-Zahlung über Stripe Payment Link (lokaler Modus)
      const checkoutUrl = this.paymentRedirectUrl(order);
      return { orderId: order.id, total, checkoutUrl: checkoutUrl || null, order };
    },

    async getOrder(orderId) {
      return load(KEYS.orders, []).find(o => o.id === orderId) || null;
    },
    async ordersForUser() {
      const email = this.currentUser();
      return load(KEYS.orders, []).filter(o => o.email === email);
    },
    async getAllOrders() { return load(KEYS.orders, []).slice().reverse(); },

    async setOrderStatus(orderId, status, via) {
      const orders = load(KEYS.orders, []);
      const o = orders.find(x => x.id === orderId);
      if (o) {
        const wasPaid = o.status === 'bezahlt';
        o.status = status;
        if (status === 'bezahlt' && via) { o.paidVia = via; o.paidAt = new Date().toISOString(); }
        save(KEYS.orders, orders);
        if (status === 'bezahlt' && !wasPaid && await this.emailConfigured()) {
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

    /* --- Payment Links (nur lokaler Modus) --- */
    orderPaymentLink(order) {
      const links = [...new Set(order.items.map(i => i.paymentLink || ''))];
      return (links.length === 1 && links[0]) ? links[0] : '';
    },
    paymentRedirectUrl(order) {
      const link = this.orderPaymentLink(order);
      if (!link) return '';
      return link + (link.includes('?') ? '&' : '?') +
        'client_reference_id=' + encodeURIComponent(order.id) +
        '&prefilled_email=' + encodeURIComponent(order.email);
    },
    setPendingPayment(orderId) { localStorage.setItem(KEYS.pending, orderId); },
    consumePendingPayment() {
      const id = localStorage.getItem(KEYS.pending);
      localStorage.removeItem(KEYS.pending);
      return id || null;
    },
    async confirmOnlinePayment(orderId) {
      const o = load(KEYS.orders, []).find(x => x.id === orderId);
      if (!o || o.status !== 'offen') return null;
      return this.setOrderStatus(orderId, 'bezahlt', 'stripe');
    },
    async retryPayment(orderId) {
      const o = await this.getOrder(orderId);
      if (!o) throw new Error('Bestellung nicht gefunden.');
      const url = this.paymentRedirectUrl(o);
      if (!url) throw new Error('Für diese Bestellung ist keine Online-Zahlung hinterlegt.');
      this.setPendingPayment(orderId);
      return url;
    },

    /* --- Check-in --- */
    async checkIn(code) {
      code = String(code || '').trim().toUpperCase();
      const orders = load(KEYS.orders, []);
      let found = null;
      for (const o of orders) {
        const t = o.tickets.find(t => t.code === code);
        if (t) { found = { order: o, ticket: t }; break; }
      }
      if (!found) throw new Error('Ticketcode nicht gefunden.');
      if (found.order.status === 'storniert') throw new Error('Bestellung wurde storniert – Ticket ungültig.');
      if (found.order.status !== 'bezahlt') throw new Error('Bestellung ' + found.order.id +
        ' ist noch nicht bezahlt – Ticket nicht gültig. Zuerst unter „Bestellungen“ als bezahlt markieren.');
      if (found.ticket.checkedIn) throw new Error('Ticket wurde bereits eingecheckt (' +
        new Date(found.ticket.checkedInAt).toLocaleString('de-AT') + ').');
      found.ticket.checkedIn = true;
      found.ticket.checkedInAt = new Date().toISOString();
      save(KEYS.orders, orders);
      return found;
    },

    /* --- Admin (PIN) --- */
    async adminLogin(pin) {
      const hash = await sha256('cm-admin:' + String(pin).trim());
      if (hash !== (await this.getSettings()).adminPinHash) throw new Error('Falsche PIN.');
      sessionStorage.setItem(KEYS.admin, '1');
      return true;
    },
    async adminLoggedIn() { return sessionStorage.getItem(KEYS.admin) === '1'; },
    async adminLogout() { sessionStorage.removeItem(KEYS.admin); },
    async setAdminPin(pin) {
      pin = String(pin).trim();
      if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN muss 4–8 Ziffern haben.');
      await this.saveSettings({ adminPinHash: await sha256('cm-admin:' + pin) });
    },
    async userCount() { return load(KEYS.users, []).length; },
    async resetAll() { Object.values(KEYS).forEach(k => localStorage.removeItem(k)); }
  };

  /* ================= Backend-Modus (Supabase) ================= */

  const CFG = global.CM_CONFIG || {};
  const REMOTE = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && global.supabase);
  let sb = null;
  let cachedEmail = null;

  const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

  function mapOrderRow(row) {
    return {
      id: row.id,
      email: row.email,
      createdAt: row.created_at,
      status: row.status,
      paidVia: row.paid_via || null,
      total: Number(row.total),
      items: (row.order_items || []).map(i => ({
        categoryId: i.category_id, categoryName: i.category_name,
        eventName: i.event_name, qty: i.qty, price: Number(i.price), paymentLink: ''
      })),
      tickets: (row.tickets || []).map(t => ({
        code: t.code, categoryId: t.category_id, categoryName: t.category_name,
        eventName: t.event_name, eventDate: t.event_date, eventLocation: t.event_location,
        price: Number(t.price), checkedIn: t.checked_in, checkedInAt: t.checked_in_at
      }))
    };
  }

  const ORDER_SELECT = '*, order_items(*), tickets(*)';

  async function fnError(error, fallback) {
    let m = fallback;
    try {
      if (error && error.context && typeof error.context.json === 'function') {
        const j = await error.context.json();
        if (j && j.error) m = j.error;
      }
    } catch (e) { /* ignorieren */ }
    return new Error(m);
  }

  const Remote = {
    remote: true,

    async init() {
      sb = global.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
      const { data } = await sb.auth.getSession();
      cachedEmail = data && data.session ? normEmail(data.session.user.email) : null;
      sb.auth.onAuthStateChange((_e, session) => {
        cachedEmail = session ? normEmail(session.user.email) : null;
      });
    },

    /* --- Einstellungen --- */
    async getSettings() {
      const { data } = await sb.from('settings').select('*');
      const map = {};
      (data || []).forEach(r => { map[r.key] = r.value; });
      return {
        shopName: 'CORE Management Ticketshop',
        checkoutNote: typeof map.checkout_note === 'string' ? map.checkout_note
          : 'Die Tickets sind verbindlich reserviert.',
        stripeEnabled: map.stripe_enabled !== false,
        maxPerOrder: 10
      };
    },
    async saveSettings(patch) {
      if (patch.checkoutNote != null) {
        const { error } = await sb.from('settings')
          .upsert({ key: 'checkout_note', value: patch.checkoutNote });
        if (error) throw new Error('Speichern fehlgeschlagen: ' + error.message);
      }
      return this.getSettings();
    },
    async emailConfigured() { return true; }, // Supabase versendet die Codes

    /* --- Events --- */
    async getEvents() {
      const { data, error } = await sb.from('events')
        .select('*, categories(*)')
        .order('date', { ascending: true });
      if (error) throw new Error('Events konnten nicht geladen werden: ' + error.message);
      return (data || []).map(e => ({
        id: e.id, name: e.name,
        date: e.date ? e.date.slice(0, 16) : '',
        location: e.location || '', description: e.description || '',
        active: e.active,
        categories: (e.categories || []).sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(c => ({
          id: c.id, name: c.name, price: Number(c.price), quota: c.quota,
          maxPerOrder: c.max_per_order, description: c.description || '',
          active: c.active, paymentLink: ''
        }))
      }));
    },
    async getEvent(id) { return (await this.getEvents()).find(e => e.id === id) || null; },

    async upsertEvent(ev) {
      const row = {
        name: ev.name, date: ev.date || null, location: ev.location,
        description: ev.description, active: ev.active
      };
      let eventId = ev.id;
      if (isUuid(eventId)) {
        const { error } = await sb.from('events').update(row).eq('id', eventId);
        if (error) throw new Error('Event speichern fehlgeschlagen: ' + error.message);
      } else {
        const { data, error } = await sb.from('events').insert(row).select('id').single();
        if (error) throw new Error('Event anlegen fehlgeschlagen: ' + error.message);
        eventId = data.id;
      }
      // Kategorien abgleichen
      const { data: existing } = await sb.from('categories').select('id').eq('event_id', eventId);
      const keep = [];
      for (let i = 0; i < ev.categories.length; i++) {
        const c = ev.categories[i];
        const catRow = {
          event_id: eventId, name: c.name, price: c.price, quota: c.quota,
          max_per_order: c.maxPerOrder || 10, description: c.description,
          active: c.active, sort: i
        };
        if (isUuid(c.id)) {
          keep.push(c.id);
          const { error } = await sb.from('categories').update(catRow).eq('id', c.id);
          if (error) throw new Error('Kategorie speichern fehlgeschlagen: ' + error.message);
        } else {
          const { data, error } = await sb.from('categories').insert(catRow).select('id').single();
          if (error) throw new Error('Kategorie anlegen fehlgeschlagen: ' + error.message);
          keep.push(data.id);
        }
      }
      const remove = (existing || []).map(x => x.id).filter(id => !keep.includes(id));
      if (remove.length) await sb.from('categories').delete().in('id', remove);
      ev.id = eventId;
      return ev;
    },

    async deleteEvent(id) {
      const { error } = await sb.from('events').delete().eq('id', id);
      if (error) throw new Error('Löschen fehlgeschlagen: ' + error.message);
    },

    async soldByCategory() {
      const { data, error } = await sb.rpc('category_sold');
      if (error) return {};
      const sold = {};
      (data || []).forEach(r => { sold[r.category_id] = Number(r.sold); });
      return sold;
    },

    /* --- Login / Verifizierung (Supabase-OTP per E-Mail) --- */
    async requestCode(email) {
      email = normEmail(email);
      if (!validEmail(email)) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
      const { error } = await sb.auth.signInWithOtp({
        email, options: { shouldCreateUser: true }
      });
      if (error) {
        if (/rate/i.test(error.message)) throw new Error('Bitte kurz warten, bevor ein neuer Code angefordert wird.');
        throw new Error('Code konnte nicht gesendet werden: ' + error.message);
      }
      return { demo: false };
    },

    async verifyCode(email, code) {
      email = normEmail(email);
      const { data, error } = await sb.auth.verifyOtp({
        email, token: String(code).trim(), type: 'email'
      });
      if (error) throw new Error('Falscher oder abgelaufener Code.');
      cachedEmail = normEmail(data.user.email);
      return { email: cachedEmail };
    },

    currentUser() { return cachedEmail; },
    async logout() { await sb.auth.signOut(); cachedEmail = null; },

    /* --- Bestellungen (über Edge Function, serverseitig geprüft) --- */
    async placeOrder(cartItems) {
      if (!this.currentUser()) throw new Error('Bitte zuerst mit E-Mail anmelden.');
      const items = cartItems.map(i => ({ categoryId: i.categoryId, qty: i.qty }));
      const { data, error } = await sb.functions.invoke('place-order', { body: { items } });
      if (error) throw await fnError(error, 'Bestellung fehlgeschlagen. Bitte erneut versuchen.');
      return { orderId: data.orderId, total: data.total, checkoutUrl: data.checkoutUrl || null };
    },

    async retryPayment(orderId) {
      const { data, error } = await sb.functions.invoke('place-order', { body: { retryOrderId: orderId } });
      if (error) throw await fnError(error, 'Bezahlseite konnte nicht geöffnet werden.');
      if (!data.checkoutUrl) throw new Error('Für diese Bestellung ist keine Online-Zahlung verfügbar.');
      return data.checkoutUrl;
    },

    async getOrder(orderId) {
      const { data, error } = await sb.from('orders').select(ORDER_SELECT).eq('id', orderId).maybeSingle();
      if (error || !data) return null;
      return mapOrderRow(data);
    },
    async ordersForUser() {
      const email = this.currentUser();
      if (!email) return [];
      const { data, error } = await sb.from('orders').select(ORDER_SELECT)
        .eq('email', email).order('created_at', { ascending: true });
      if (error) throw new Error('Bestellungen konnten nicht geladen werden: ' + error.message);
      return (data || []).map(mapOrderRow);
    },
    async getAllOrders() {
      const { data, error } = await sb.from('orders').select(ORDER_SELECT)
        .order('created_at', { ascending: false });
      if (error) throw new Error('Bestellungen konnten nicht geladen werden: ' + error.message);
      return (data || []).map(mapOrderRow);
    },

    async setOrderStatus(orderId, status, via) {
      const patch = { status };
      if (status === 'bezahlt') {
        patch.paid_via = via || 'manuell';
        patch.paid_at = new Date().toISOString();
      }
      const { error } = await sb.from('orders').update(patch).eq('id', orderId);
      if (error) throw new Error('Status konnte nicht geändert werden: ' + error.message);
      return this.getOrder(orderId);
    },

    // Nach Rückkehr von Stripe: auf die Webhook-Bestätigung warten
    async waitForPayment(orderId, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 30000);
      while (Date.now() < deadline) {
        const o = await this.getOrder(orderId);
        if (o && o.status === 'bezahlt') return o;
        if (o && o.status === 'storniert') return o;
        await new Promise(r => setTimeout(r, 2500));
      }
      return this.getOrder(orderId);
    },

    setPendingPayment() {},
    consumePendingPayment() { return null; },

    /* --- Check-in --- */
    async checkIn(code) {
      code = String(code || '').trim().toUpperCase();
      const { data: t, error } = await sb.from('tickets')
        .select('*, orders(id, email, status)')
        .eq('code', code).maybeSingle();
      if (error) throw new Error('Suche fehlgeschlagen: ' + error.message);
      if (!t) throw new Error('Ticketcode nicht gefunden.');
      const order = t.orders;
      if (order.status === 'storniert') throw new Error('Bestellung wurde storniert – Ticket ungültig.');
      if (order.status !== 'bezahlt') throw new Error('Bestellung ' + order.id +
        ' ist noch nicht bezahlt – Ticket nicht gültig.');
      if (t.checked_in) throw new Error('Ticket wurde bereits eingecheckt (' +
        new Date(t.checked_in_at).toLocaleString('de-AT') + ').');
      const { data: upd, error: updErr } = await sb.from('tickets')
        .update({ checked_in: true, checked_in_at: new Date().toISOString() })
        .eq('code', code).eq('checked_in', false).select();
      if (updErr) throw new Error('Check-in fehlgeschlagen: ' + updErr.message);
      if (!upd || !upd.length) throw new Error('Ticket wurde soeben bereits eingecheckt.');
      return {
        order: { id: order.id, email: order.email, status: order.status },
        ticket: { code: t.code, categoryName: t.category_name, eventName: t.event_name }
      };
    },

    /* --- Admin (Supabase-Login + admins-Tabelle) --- */
    async adminLoggedIn() {
      if (!this.currentUser()) return false;
      const { data } = await sb.rpc('is_admin');
      return data === true;
    },
    async adminLogout() { await this.logout(); },
    async userCount() { return null; }, // wird aus Bestellungen abgeleitet
    async resetAll() { throw new Error('Im Backend-Modus bitte direkt in Supabase verwalten.'); }
  };

  /* ================= Export ================= */

  const S = REMOTE ? Remote : Local;
  S.KEYS = KEYS;
  S.uid = uid;
  S.sha256 = sha256;
  S.fmtEUR = fmtEUR;
  S.validEmail = validEmail;
  S.normEmail = normEmail;
  S.remainingOf = remainingOf;
  S.computeStats = computeStats;
  S.computeSalesByDay = computeSalesByDay;
  S.computeRevenueByCategory = computeRevenueByCategory;
  S.exportCSV = exportCSV;
  global.CMStore = S;
})(window);
