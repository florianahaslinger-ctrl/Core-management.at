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

    const { items } = await req.json() as { items: { category_id: string; qty: number }[] };
    if (!Array.isArray(items) || !items.length) {
      return json({ error: "Der Warenkorb ist leer." }, 400);
    }

    // Kategorien + Event + Verfügbarkeit prüfen
    const ids = items.map((i) => i.category_id);
    const { data: cats, error: catErr } = await admin
      .from("categories")
      .select("id,name,price,quota,max_per_order,active,event_id,events(name,date,location,active)")
      .in("id", ids);
    if (catErr) throw catErr;

    const { data: sold } = await admin.from("category_sold").select("category_id,sold").in("category_id", ids);
    const soldMap = new Map((sold ?? []).map((s) => [s.category_id, s.sold]));

    let total = 0;
    const orderItems: Record<string, unknown>[] = [];
    const lineItems: string[] = [];
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
      total += Number(cat.price) * qty;
      orderItems.push({
        category_id: cat.id, event_name: ev.name, category_name: cat.name, price: cat.price, qty,
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

    // Bestellung anlegen (offen)
    const orderId = "B" + Date.now().toString().slice(-8);
    const { error: oErr } = await admin.from("orders").insert({ id: orderId, email, total, status: "offen" });
    if (oErr) throw oErr;
    const { error: iErr } = await admin.from("order_items").insert(
      orderItems.map((x) => ({ ...x, order_id: orderId })),
    );
    if (iErr) throw iErr;

    // Stripe Checkout Session
    const body =
      `mode=payment&client_reference_id=${orderId}` +
      `&customer_email=${encodeURIComponent(email)}` +
      `&metadata[order_id]=${orderId}` +
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
