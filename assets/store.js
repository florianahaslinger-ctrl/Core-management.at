/* =========================================================
   CORE Management Ticketshop – Datenschicht (store.js)
   Backend: Supabase (zentrale Datenbank, E-Mail-Login mit
   Verifizierung) + Stripe Checkout mit Webhook-Bestätigung.
   Der geheime Stripe-Schlüssel liegt NUR in den Supabase-
   Edge-Functions – niemals hier im Frontend.
   ========================================================= */
(function (global) {
  'use strict';

  const SUPA_URL = 'https://xfdiuhmgkdujbjhdhvcw.supabase.co';
  // Öffentlicher (anon) Schlüssel – durch Row Level Security abgesichert
  const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGl1aG1na2R1amJqaGRodmN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNDI5MzUsImV4cCI6MjA5ODkxODkzNX0.HKKSNdNuIQXxh00LqvRFQciFMeF6oXrvvj-Gl9EaqmY';

  let sb = null;          // Supabase-Client
  let session = null;     // aktuelle Auth-Session

  const fmtEUR = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });

  function normEmail(email) { return String(email || '').trim().toLowerCase(); }
  function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(email)); }

  function niceAuthError(e) {
    const m = (e && e.message) || String(e);
    if (/rate limit/i.test(m)) return 'E-Mail-Limit erreicht – bitte in einer Stunde erneut versuchen. (Tipp: eigenen SMTP-Server in Supabase hinterlegen, dann entfällt das Limit.)';
    if (/expired|invalid/i.test(m) && /token|otp/i.test(m)) return 'Der Code ist ungültig oder abgelaufen. Bitte neuen Code anfordern.';
    if (/security purposes/i.test(m)) return 'Bitte kurz warten – ein Code wurde gerade erst gesendet.';
    return m;
  }

  function mapOrder(o) {
    return {
      id: o.id, email: o.email, status: o.status, total: Number(o.total),
      paidVia: o.paid_via, paidAt: o.paid_at, createdAt: o.created_at,
      items: (o.order_items || []).map(i => ({
        categoryId: i.category_id, categoryName: i.category_name,
        eventName: i.event_name, price: Number(i.price), qty: i.qty
      })),
      tickets: (o.tickets || []).map(t => ({
        code: t.code, categoryId: t.category_id, categoryName: t.category_name,
        eventName: t.event_name, eventDate: t.event_date, eventLocation: t.event_location,
        price: Number(t.price), checkedIn: t.checked_in, checkedInAt: t.checked_in_at
      }))
    };
  }

  const ORDER_SELECT = 'id,email,status,total,paid_via,paid_at,created_at,' +
    'order_items(category_id,category_name,event_name,price,qty),' +
    'tickets(code,category_id,category_name,event_name,event_date,event_location,price,checked_in,checked_in_at)';

  const Store = {
    fmtEUR, validEmail, normEmail,

    /* --- Initialisierung & Auth --- */
    async init() {
      sb = supabase.createClient(SUPA_URL, SUPA_ANON);
      const { data } = await sb.auth.getSession();
      session = data.session;
      sb.auth.onAuthStateChange((_ev, s) => { session = s; });
      return session;
    },
    client() { return sb; },
    currentUser() { return session && session.user ? normEmail(session.user.email) : null; },

    async requestCode(email) {
      email = normEmail(email);
      if (!validEmail(email)) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname }
      });
      if (error) throw new Error(niceAuthError(error));
      return { demo: false };
    },

    async verifyCode(email, code) {
      const { data, error } = await sb.auth.verifyOtp({
        email: normEmail(email), token: String(code).replace(/\D/g, ''), type: 'email'
      });
      if (error) throw new Error(niceAuthError(error));
      session = data.session;
      return data.user;
    },

    async logout() { await sb.auth.signOut(); session = null; },

    /* --- Events & Verfügbarkeit --- */
    async getEvents(includeInactive) {
      let q = sb.from('events')
        .select('id,name,date,location,description,active,categories(id,name,price,quota,max_per_order,description,active,sort)')
        .order('date', { ascending: true });
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const { data: sold } = await sb.from('category_sold').select('category_id,sold');
      const soldMap = {};
      (sold || []).forEach(s => { soldMap[s.category_id] = s.sold; });
      return (data || [])
        .filter(e => includeInactive || e.active)
        .map(e => ({
          id: e.id, name: e.name, date: e.date, location: e.location,
          description: e.description, active: e.active,
          categories: (e.categories || [])
            .sort((a, b) => (a.sort || 0) - (b.sort || 0))
            .map(c => ({
              id: c.id, name: c.name, price: Number(c.price), quota: c.quota,
              maxPerOrder: c.max_per_order, description: c.description, active: c.active,
              sold: soldMap[c.id] || 0, remaining: Math.max(0, c.quota - (soldMap[c.id] || 0))
            }))
        }));
    },

    /* --- Checkout (Stripe) --- */
    async startCheckout(items) {
      // items: [{category_id, qty}] – Edge Function prüft alles serverseitig
      const { data, error } = await sb.functions.invoke('create-checkout', { body: { items } });
      if (error) {
        let msg = 'Zahlung konnte nicht gestartet werden.';
        try {
          const body = await error.context.json();
          if (body && body.error) msg = body.error;
        } catch (_) { /* Standardmeldung */ }
        throw new Error(msg);
      }
      return data; // { url, order_id }
    },

    /* --- Bestellungen --- */
    async myOrders() {
      const email = this.currentUser();
      if (!email) return [];
      const { data, error } = await sb.from('orders').select(ORDER_SELECT)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data || []).map(mapOrder);
    },

    async getOrder(id) {
      const { data, error } = await sb.from('orders').select(ORDER_SELECT).eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? mapOrder(data) : null;
    },

    // Wartet nach Rückkehr von Stripe, bis der Webhook die Bestellung bestätigt hat
    async waitForPayment(orderId, timeoutMs) {
      const until = Date.now() + (timeoutMs || 25000);
      while (Date.now() < until) {
        const o = await this.getOrder(orderId);
        if (o && o.status === 'bezahlt') return o;
        await new Promise(r => setTimeout(r, 1800));
      }
      return this.getOrder(orderId);
    },

    /* --- Admin --- */
    async isAdmin() {
      const email = this.currentUser();
      if (!email) return false;
      const { data } = await sb.from('admins').select('email').eq('email', email).maybeSingle();
      return !!data;
    },

    async allOrders() {
      const { data, error } = await sb.from('orders').select(ORDER_SELECT)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data || []).map(mapOrder);
    },

    async setOrderStatus(orderId, status) {
      const { error } = await sb.from('orders').update({ status }).eq('id', orderId);
      if (error) throw new Error(error.message);
    },

    // Ticketcode aus beliebigem Scan-/Eingabetext ziehen (auch aus QR-URLs)
    extractCode(text) {
      const m = String(text || '').toUpperCase().match(/CM-[A-Z0-9]{4}-[A-Z0-9]{4}/);
      return m ? m[0] : String(text || '').trim().toUpperCase();
    },

    async checkIn(code) {
      const { data, error } = await sb.rpc('check_in_ticket', { p_code: this.extractCode(code) });
      if (error) throw new Error(error.message.replace(/^.*?: /, ''));
      return data; // { code, category, event, email }
    },

    // Öffentliche Statusabfrage (für die Ticket-Seite hinter dem QR-Code)
    async ticketStatus(code) {
      const { data, error } = await sb.rpc('ticket_status', { p_code: this.extractCode(code) });
      if (error) throw new Error(error.message);
      return data;
    },

    /* --- Event-/Kategorie-Verwaltung (Admin, modular) --- */
    async saveEvent(ev) {
      const row = {
        name: ev.name, date: ev.date || null, location: ev.location || null,
        description: ev.description || null, active: !!ev.active
      };
      let eventId = ev.id;
      if (eventId) {
        const { error } = await sb.from('events').update(row).eq('id', eventId);
        if (error) throw new Error(error.message);
      } else {
        const { data, error } = await sb.from('events').insert(row).select('id').single();
        if (error) throw new Error(error.message);
        eventId = data.id;
      }
      // Kategorien abgleichen
      const { data: existing } = await sb.from('categories').select('id').eq('event_id', eventId);
      const keep = new Set();
      for (let i = 0; i < ev.categories.length; i++) {
        const c = ev.categories[i];
        const crow = {
          event_id: eventId, name: c.name, price: c.price, quota: c.quota,
          max_per_order: c.maxPerOrder || 10, description: c.description || null,
          active: !!c.active, sort: i
        };
        if (c.id && (existing || []).some(x => x.id === c.id)) {
          keep.add(c.id);
          const { error } = await sb.from('categories').update(crow).eq('id', c.id);
          if (error) throw new Error(error.message);
        } else {
          const { data, error } = await sb.from('categories').insert(crow).select('id').single();
          if (error) throw new Error(error.message);
          keep.add(data.id);
        }
      }
      for (const x of existing || []) {
        if (!keep.has(x.id)) await sb.from('categories').delete().eq('id', x.id);
      }
      return eventId;
    },

    async setEventActive(id, active) {
      const { error } = await sb.from('events').update({ active }).eq('id', id);
      if (error) throw new Error(error.message);
    },

    async deleteEvent(id) {
      const { error } = await sb.from('events').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },

    async getAdmins() {
      const { data, error } = await sb.from('admins').select('email').order('email');
      if (error) throw new Error(error.message);
      return (data || []).map(a => a.email);
    },
    async addAdmin(email) {
      email = normEmail(email);
      if (!validEmail(email)) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
      const { error } = await sb.from('admins').insert({ email });
      if (error) throw new Error(error.message);
    },
    async removeAdmin(email) {
      const { error } = await sb.from('admins').delete().eq('email', normEmail(email));
      if (error) throw new Error(error.message);
    },

    /* --- Statistik (aus geladenen Bestellungen berechnet) --- */
    stats(orders) {
      const valid = orders.filter(o => o.status !== 'storniert');
      const tickets = valid.flatMap(o => o.tickets);
      const paid = valid.filter(o => o.status === 'bezahlt');
      return {
        revenue: paid.reduce((s, o) => s + o.total, 0),
        orderCount: valid.length,
        ticketCount: tickets.length,
        checkinCount: tickets.filter(t => t.checkedIn).length,
        openCount: orders.filter(o => o.status === 'offen').length
      };
    },

    salesByDay(orders, days) {
      const out = [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        out.push({ date: d, label: d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' }), qty: 0, revenue: 0 });
      }
      orders.forEach(o => {
        if (o.status !== 'bezahlt') return;
        const od = new Date(o.createdAt); od.setHours(0, 0, 0, 0);
        const slot = out.find(x => x.date.getTime() === od.getTime());
        if (slot) { slot.qty += o.tickets.length; slot.revenue += o.total; }
      });
      return out;
    },

    revenueByCategory(orders) {
      const map = {};
      orders.forEach(o => {
        if (o.status !== 'bezahlt') return;
        o.items.forEach(it => {
          const key = it.categoryName + ' · ' + it.eventName;
          if (!map[key]) map[key] = { label: it.categoryName, event: it.eventName, revenue: 0, qty: 0 };
          map[key].revenue += it.price * it.qty;
          map[key].qty += it.qty;
        });
      });
      return Object.values(map).sort((a, b) => b.revenue - a.revenue);
    },

    exportOrdersCSV(orders) {
      const rows = [['Bestellung', 'Datum', 'E-Mail', 'Status', 'Zahlart', 'Ticketcode', 'Event', 'Kategorie', 'Preis', 'Check-in']];
      orders.forEach(o => {
        if (o.tickets.length) {
          o.tickets.forEach(t => rows.push([o.id, o.createdAt, o.email, o.status, o.paidVia || '', t.code,
            t.eventName, t.categoryName, String(t.price).replace('.', ','), t.checkedIn ? t.checkedInAt : '']));
        } else {
          o.items.forEach(i => rows.push([o.id, o.createdAt, o.email, o.status, o.paidVia || '', '',
            i.eventName, i.qty + '× ' + i.categoryName, String(i.price * i.qty).replace('.', ','), '']));
        }
      });
      return rows.map(r => r.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
    }
  };

  global.CMStore = Store;
})(window);
