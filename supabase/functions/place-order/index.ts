// =========================================================
// CORE Management Ticketshop – Edge Function "place-order"
// Legt eine Bestellung serverseitig an (Preise & Kontingente
// werden aus der Datenbank geprüft) und erstellt bei aktivierter
// Online-Zahlung eine Stripe-Checkout-Session.
// Mit { retryOrderId } kann die Zahlung einer bestehenden
// offenen Bestellung nachgeholt werden.
//
// Secrets (Supabase Dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY  – sk_live_... / sk_test_...  (optional)
//   SITE_URL           – z. B. https://core-management.at (optional)
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function ticketCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const block = (o: number) =>
    Array.from(rnd.slice(o, o + 4)).map((x) => chars[x % chars.length]).join("");
  return "CM-" + block(0) + "-" + block(4);
}

type LineItem = { name: string; amountCents: number; qty: number };

async function createCheckoutSession(
  stripeKey: string, orderId: string, email: string, lineItems: LineItem[],
): Promise<{ ok: boolean; url?: string; id?: string; error?: unknown }> {
  const site = (Deno.env.get("SITE_URL") ?? "https://core-management.at").replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("customer_email", email);
  params.set("client_reference_id", orderId);
  params.set("metadata[order_id]", orderId);
  params.set("success_url", site + "/tickets.html?paid=1&order=" + orderId);
  params.set("cancel_url", site + "/tickets.html?cancelled=1&order=" + orderId);
  lineItems.forEach((li, i) => {
    params.set(`line_items[${i}][price_data][currency]`, "eur");
    params.set(`line_items[${i}][price_data][product_data][name]`, li.name);
    params.set(`line_items[${i}][price_data][unit_amount]`, String(li.amountCents));
    params.set(`line_items[${i}][quantity]`, String(li.qty));
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + stripeKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const session = await res.json();
  if (!res.ok) return { ok: false, error: session };
  return { ok: true, url: session.url, id: session.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST erlaubt." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Eingeloggten Benutzer aus dem Authorization-Header ermitteln
    const authHeader = req.headers.get("Authorization") ?? "";
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user?.email) {
      return json({ error: "Bitte zuerst mit E-Mail anmelden." }, 401);
    }
    const email = userData.user.email.toLowerCase();
    const userId = userData.user.id;

    const db = createClient(supabaseUrl, serviceKey);
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
    const { data: stripeSetting } = await db
      .from("settings").select("value").eq("key", "stripe_enabled").maybeSingle();
    const stripeEnabled = !!stripeKey && stripeSetting?.value !== false;

    const body = await req.json().catch(() => ({}));

    // ----- Nachträgliche Zahlung einer bestehenden offenen Bestellung -----
    if (body.retryOrderId) {
      if (!stripeEnabled) return json({ error: "Online-Zahlung ist derzeit nicht verfügbar." }, 400);
      const { data: order } = await db
        .from("orders").select("*, order_items(*)")
        .eq("id", String(body.retryOrderId)).eq("email", email).eq("status", "offen")
        .maybeSingle();
      if (!order) return json({ error: "Keine offene Bestellung mit dieser Nummer gefunden." }, 404);
      const lineItems: LineItem[] = (order.order_items ?? []).map((i: {
        category_name: string; event_name: string; price: number; qty: number;
      }) => ({
        name: i.category_name + " – " + i.event_name,
        amountCents: Math.round(Number(i.price) * 100),
        qty: i.qty,
      }));
      const s = await createCheckoutSession(stripeKey, order.id, email, lineItems);
      if (!s.ok) {
        console.error("Stripe-Fehler:", s.error);
        return json({ error: "Die Bezahlseite konnte nicht erstellt werden." }, 502);
      }
      await db.from("orders").update({ stripe_session_id: s.id }).eq("id", order.id);
      return json({ orderId: order.id, total: Number(order.total), checkoutUrl: s.url });
    }

    // ----- Neue Bestellung -----
    const items: Array<{ categoryId: string; qty: number }> =
      Array.isArray(body.items) ? body.items : [];
    if (!items.length) return json({ error: "Der Warenkorb ist leer." }, 400);

    const catIds = items.map((i) => i.categoryId);
    const { data: cats, error: catErr } = await db
      .from("categories")
      .select("*, events(*)")
      .in("id", catIds);
    if (catErr) throw catErr;

    const { data: soldRows, error: soldErr } = await db.rpc("category_sold");
    if (soldErr) throw soldErr;
    const sold: Record<string, number> = {};
    (soldRows ?? []).forEach((r: { category_id: string; sold: number }) => {
      sold[r.category_id] = Number(r.sold);
    });

    let total = 0;
    const orderItems: Array<Record<string, unknown>> = [];
    const tickets: Array<Record<string, unknown>> = [];
    const lineItems: LineItem[] = [];

    for (const it of items) {
      const qty = Math.floor(Number(it.qty));
      const cat = (cats ?? []).find((c) => c.id === it.categoryId);
      const ev = cat?.events;
      if (!cat || !ev || !cat.active || !ev.active) {
        return json({ error: "Eine Ticketkategorie ist nicht mehr verfügbar." }, 400);
      }
      if (!Number.isFinite(qty) || qty < 1 || qty > (cat.max_per_order ?? 10)) {
        return json({ error: "Ungültige Menge für „" + cat.name + "“." }, 400);
      }
      const rest = Math.max(0, (cat.quota ?? 0) - (sold[cat.id] ?? 0));
      if (qty > rest) {
        return json({ error: "Für „" + cat.name + "“ sind nur noch " + rest + " Tickets verfügbar." }, 409);
      }
      const price = Number(cat.price);
      total += price * qty;
      orderItems.push({
        category_id: cat.id, category_name: cat.name, event_name: ev.name, qty, price,
      });
      lineItems.push({
        name: cat.name + " – " + ev.name,
        amountCents: Math.round(price * 100),
        qty,
      });
      for (let i = 0; i < qty; i++) {
        tickets.push({
          code: ticketCode(), category_id: cat.id, category_name: cat.name,
          event_name: ev.name, event_date: ev.date, event_location: ev.location,
          price,
        });
      }
    }

    const orderId = "B" + Date.now().toString().slice(-8);
    const { error: ordErr } = await db.from("orders").insert({
      id: orderId, email, user_id: userId, status: "offen", total,
    });
    if (ordErr) throw ordErr;
    const { error: itemErr } = await db.from("order_items")
      .insert(orderItems.map((i) => ({ ...i, order_id: orderId })));
    if (itemErr) throw itemErr;
    const { error: tickErr } = await db.from("tickets")
      .insert(tickets.map((t) => ({ ...t, order_id: orderId })));
    if (tickErr) throw tickErr;

    let checkoutUrl: string | null = null;
    if (stripeEnabled) {
      const s = await createCheckoutSession(stripeKey, orderId, email, lineItems);
      if (!s.ok) {
        // Bestellung zurücknehmen, damit kein Kontingent blockiert wird
        await db.from("orders").delete().eq("id", orderId);
        console.error("Stripe-Fehler:", s.error);
        return json({ error: "Die Bezahlseite konnte nicht erstellt werden. Bitte später erneut versuchen." }, 502);
      }
      checkoutUrl = s.url ?? null;
      await db.from("orders").update({ stripe_session_id: s.id }).eq("id", orderId);
    }

    return json({ orderId, total, checkoutUrl });
  } catch (e) {
    console.error(e);
    return json({ error: "Interner Fehler bei der Bestellung." }, 500);
  }
});
