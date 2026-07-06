// =========================================================
// CORE Management Ticketshop – Edge Function "stripe-webhook"
// Empfängt Stripe-Webhooks und schaltet Bestellungen nach
// verifizierter Zahlung frei (fälschungssicher: die Signatur
// wird mit dem Webhook-Secret geprüft).
//
// WICHTIG: Diese Funktion mit deaktivierter JWT-Prüfung
// deployen (Stripe sendet keinen Supabase-Login):
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Secrets:
//   STRIPE_WEBHOOK_SECRET – whsec_... (aus dem Stripe-Dashboard)
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Stripe-Signatur prüfen: HMAC-SHA256 über "<timestamp>.<payload>"
async function verifyStripeSignature(
  payload: string, sigHeader: string, secret: string,
): Promise<boolean> {
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => p.split("=") as [string, string]),
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  // Replay-Schutz: max. 5 Minuten alt
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  return await crypto.subtle.verify(
    "HMAC", key, hexToBytes(v1), encoder.encode(t + "." + payload),
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!secret) return new Response("Webhook-Secret fehlt", { status: 500 });

  const payload = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  const valid = await verifyStripeSignature(payload, sig, secret).catch(() => false);
  if (!valid) return new Response("Ungültige Signatur", { status: 400 });

  const event = JSON.parse(payload);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.order_id ?? session.client_reference_id;
    if (orderId && session.payment_status === "paid") {
      const db = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { error } = await db
        .from("orders")
        .update({
          status: "bezahlt",
          paid_via: "stripe",
          paid_at: new Date().toISOString(),
          stripe_session_id: session.id,
        })
        .eq("id", orderId)
        .eq("status", "offen");
      if (error) {
        console.error("Bestellung konnte nicht freigeschaltet werden:", error);
        return new Response("DB-Fehler", { status: 500 });
      }
      console.log("Bestellung bezahlt:", orderId);
    }
  }

  // Abgelaufene Checkout-Sessions: Bestellung stornieren, Kontingent freigeben
  if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    const orderId = session.metadata?.order_id ?? session.client_reference_id;
    if (orderId) {
      const db = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await db.from("orders").update({ status: "storniert" })
        .eq("id", orderId).eq("status", "offen");
      console.log("Checkout abgelaufen, Bestellung storniert:", orderId);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
