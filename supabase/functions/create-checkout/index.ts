// CORE Management Ticketshop – Stripe-Checkout-Session anlegen
// Aufruf mit Supabase-Auth-JWT; legt Bestellung (offen) an und gibt die Stripe-URL zurück.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SHOP_URL = Deno.env.get("SHOP_URL") ?? "https://core-management.at";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: userData, error: userErr } = await admin.auth.getUser(
      authHeader.replace(/^Bearer\s+/i, ""),
    );
    if (userErr || !userData?.user?.email) {
      return json({ error: "Bitte zuerst mit E-Mail anmelden." }, 401);
    }
    const email = userData.user.email.toLowerCase();

    const { items } = await req.json() as {
      items: { category_id: string; qty: number; seat_ids?: string[] }[];
    };
    if (!Array.isArray(items) || !items.length) {
      return json({ error: "Der Warenkorb ist leer." }, 400);
    }

    // Kategorien + Event + Verfügbarkeit prüfen
    const ids = items.map((i) => i.category_id);
    const { data: cats, error: catErr } = await admin
      .from("categories")
      .select("id,name,price,quota,max_per_order,active,seating,event_id,events(name,date,location,active)")
      .in("id", ids);
    if (catErr) throw catErr;

    const { data: sold } = await admin.from("category_sold").select("category_id,sold").in("category_id", ids);
    const soldMap = new Map((sold ?? []).map((s) => [s.category_id, s.sold]));

    let total = 0;
    const orderItems: Record<string, unknown>[] = [];
    const lineItems: string[] = [];
    const allSeatIds: string[] = [];
    let li = 0;
    for (const it of items) {
      const cat = (cats ?? []).find((c) => c.id === it.category_id);
      const ev = cat?.events as { name: string; date: string; location: string; active: boolean } | null;
      const qty = Math.floor(Number(it.qty));
      if (!cat || !cat.active || !ev?.active) return json({ error: "Eine Ticketkategorie ist nicht mehr verfügbar." }, 400);
      if (!Number.isFinite(qty) || qty < 1 || qty > cat.max_per_order) {
        return json({ error: `Ungültige Menge für „${cat.name}“ (max. ${cat.max_per_order}).` }, 400);
      }
      const rest = cat.quota - (soldMap.get(cat.id) ?? 0);
      if (qty > rest) return json({ error: `Für „${cat.name}“ sind nur noch ${Math.max(0, rest)} Tickets verfügbar.` }, 400);
      // Sitzplätze: für Sitzkarten müssen genau qty gültige Plätze gewählt sein
      if (cat.seating) {
        const seatIds = Array.isArray(it.seat_ids) ? it.seat_ids : [];
        if (seatIds.length !== qty) {
          return json({ error: `Bitte genau ${qty} Sitzplatz/Sitzplätze für „${cat.name}“ wählen.` }, 400);
        }
        const { data: seatRows } = await admin.from("seats").select("id").eq("event_id", cat.event_id).in("id", seatIds);
        if (!seatRows || seatRows.length !== seatIds.length) {
          return json({ error: "Ein gewählter Sitzplatz gehört nicht zu diesem Event." }, 400);
        }
        allSeatIds.push(...seatIds);
      }
      total += Number(cat.price) * qty;
      orderItems.push({
        category_id: cat.id, event_name: ev.name, category_name: cat.name, price: cat.price, qty,
        _seating: !!cat.seating, _seatIds: cat.seating ? (it.seat_ids ?? []) : [],
        _eventDate: ev.date ?? null, _eventLocation: ev.location ?? null,
      });
      const cents = Math.round(Number(cat.price) * 100);
      lineItems.push(
        `line_items[${li}][price_data][currency]=eur` +
        `&line_items[${li}][price_data][product_data][name]=${encodeURIComponent(cat.name + " – " + ev.name)}` +
        `&line_items[${li}][price_data][unit_amount]=${cents}` +
        `&line_items[${li}][quantity]=${qty}`,
      );
      li++;
    }

    // Gebühren aufschlüsseln (nur bei zahlungspflichtigen Bestellungen):
    //   Servicegebühr  = 3,5 % vom Ticketpreis        (CORE Management)
    //   Zahlungsgebühr = 1,5 % vom Ticketpreis + 0,25 € (Stripe-Bearbeitung)
    const subtotalCents = Math.round(total * 100);
    const paid = subtotalCents > 0;
    const serviceCents = paid ? Math.round(subtotalCents * 0.035) : 0;
    const paymentCents = paid ? Math.round(subtotalCents * 0.015) + 25 : 0;
    const grandCents = subtotalCents + serviceCents + paymentCents;
    const subtotal = subtotalCents / 100;
    const serviceFee = serviceCents / 100;
    const paymentFee = paymentCents / 100;
    const grandTotal = grandCents / 100;

    // Bestellung anlegen (offen) – total ist der zu zahlende Gesamtbetrag inkl. Gebühren
    const orderId = "B" + Date.now().toString().slice(-8);
    const { error: oErr } = await admin.from("orders").insert({
      id: orderId, email, total: grandTotal, status: "offen",
      subtotal, service_fee: serviceFee, payment_fee: paymentFee,
    });
    if (oErr) throw oErr;
    const { error: iErr } = await admin.from("order_items").insert(
      orderItems.map((x) => ({
        order_id: orderId, category_id: x.category_id, event_name: x.event_name,
        category_name: x.category_name, price: x.price, qty: x.qty,
      })),
    );
    if (iErr) throw iErr;

    // Sitzplätze reservieren (atomar) – bei Konflikt Bestellung verwerfen
    if (allSeatIds.length) {
      const { error: holdErr } = await admin.rpc("hold_seats", { p_order: orderId, p_seats: allSeatIds, p_minutes: 30 });
      if (holdErr) {
        await admin.from("orders").delete().eq("id", orderId);
        return json({ error: (holdErr.message || "Sitzplatz nicht mehr verfügbar.").replace(/^.*?:\s*/, "") }, 409);
      }
    }

    // Gratis-Bestellung (0 €): keine Stripe-Zahlung – Tickets sofort erzeugen
    if (total === 0) {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const ticketCode = () => {
        const r = crypto.getRandomValues(new Uint8Array(8));
        const b = (o: number) => Array.from(r.slice(o, o + 4)).map((x) => chars[x % chars.length]).join("");
        return "CM-" + b(0) + "-" + b(4);
      };
      const tickets: Record<string, unknown>[] = [];
      for (const x of orderItems) {
        const seatIds = x._seating ? (x._seatIds as string[]) : [];
        for (let i = 0; i < (x.qty as number); i++) {
          tickets.push({
            code: ticketCode(), order_id: orderId, category_id: x.category_id,
            event_name: x.event_name, event_date: x._eventDate, event_location: x._eventLocation,
            category_name: x.category_name, price: x.price,
            seat_id: x._seating ? (seatIds[i] ?? null) : null,
          });
        }
      }
      const { error: tErr } = await admin.from("tickets").insert(tickets);
      if (tErr) { await admin.from("orders").delete().eq("id", orderId); throw tErr; }
      await admin.from("seat_holds").delete().eq("order_id", orderId);
      await admin.from("orders").update({
        status: "bezahlt", paid_via: "gratis", paid_at: new Date().toISOString(),
      }).eq("id", orderId);
      return json({ url: SHOP_URL + "/tickets.html?order=" + orderId + "&paid=1", order_id: orderId, free: true });
    }

    // Gebühren als eigene Positionen in der Stripe-Zahlung ausweisen
    if (serviceCents > 0) {
      lineItems.push(
        `line_items[${li}][price_data][currency]=eur` +
        `&line_items[${li}][price_data][product_data][name]=${encodeURIComponent("Servicegebühr (3,5 %)")}` +
        `&line_items[${li}][price_data][unit_amount]=${serviceCents}` +
        `&line_items[${li}][quantity]=1`,
      );
      li++;
    }
    if (paymentCents > 0) {
      lineItems.push(
        `line_items[${li}][price_data][currency]=eur` +
        `&line_items[${li}][price_data][product_data][name]=${encodeURIComponent("Zahlungsgebühr (1,5 % + 0,25 €)")}` +
        `&line_items[${li}][price_data][unit_amount]=${paymentCents}` +
        `&line_items[${li}][quantity]=1`,
      );
      li++;
    }

    // Stripe Checkout Session – bei Sitzplätzen läuft die Session mit der
    // 30-Minuten-Reservierung ab, damit keine Doppelbelegung entstehen kann.
    const body =
      `mode=payment&client_reference_id=${orderId}` +
      `&customer_email=${encodeURIComponent(email)}` +
      `&metadata[order_id]=${orderId}` +
      (allSeatIds.length ? `&expires_at=${Math.floor(Date.now() / 1000) + 30 * 60}` : "") +
      `&success_url=${encodeURIComponent(SHOP_URL + "/tickets.html?order=" + orderId + "&paid=1")}` +
      `&cancel_url=${encodeURIComponent(SHOP_URL + "/tickets.html?cancelled=1")}` +
      `&${lineItems.join("&")}`;
    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + STRIPE_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const session = await resp.json();
    if (!resp.ok) {
      console.error("Stripe error:", session);
      await admin.from("orders").update({ status: "storniert" }).eq("id", orderId);
      return json({ error: "Zahlung konnte nicht gestartet werden: " + (session?.error?.message ?? resp.status) }, 502);
    }
    await admin.from("orders").update({ stripe_session_id: session.id }).eq("id", orderId);
    return json({ url: session.url, order_id: orderId });
  } catch (e) {
    console.error(e);
    return json({ error: "Interner Fehler: " + (e as Error).message }, 500);
  }
});
