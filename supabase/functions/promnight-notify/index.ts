// CORE Management Ticketshop – Rückkanal an promnight (Spec §11, Zusteller)
// ---------------------------------------------------------------------------
// Konsument der Outbox `promnight_outbox`. Stellt fällige Meldungen an promnight
// zu: POST mit HMAC-SHA256 über den Body (X-CM-Signature) + X-CM-Timestamp.
// Bei Nicht-200 Backoff 1/5/30 min, danach 'dead'. Idempotenz über event_id.
//
// Aufruf minütlich per Cron (siehe README). Geschützt über den internen
// Header X-CM-Internal == CM_INTERNAL_SECRET. Deploy mit verify_jwt=false.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_URL  = Deno.env.get("PROMNIGHT_WEBHOOK_URL") ?? "https://www.promnight.at/api/webhooks/core-management";
const WEBHOOK_SECRET = Deno.env.get("PROMNIGHT_WEBHOOK_SECRET") ?? "";
const INTERNAL_SECRET = Deno.env.get("CM_INTERNAL_SECRET") ?? "";

const BATCH = 20;
const BACKOFF_MIN = [1, 5, 30];   // Wartezeit vor Versuch 2, 3, 4 (danach 'dead')

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deliver(admin: any, row: any): Promise<boolean> {
  const body = JSON.stringify(row.payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(WEBHOOK_SECRET, body);

  let ok = false, errText = "";
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000); // promnight antwortet in <5 s (§11)
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CM-Timestamp": ts,
        "X-CM-Signature": `sha256=${sig}`,
      },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(to);
    ok = res.status === 200;
    if (!ok) errText = `HTTP ${res.status}`;
  } catch (e) {
    errText = String(e);
  }

  if (ok) {
    await admin.from("promnight_outbox").update({
      status: "delivered", delivered_at: new Date().toISOString(), last_error: null,
    }).eq("event_id", row.event_id);
    return true;
  }

  // Fehlversuch -> Backoff bzw. aufgeben
  const attempts = (row.attempts ?? 0) + 1;
  const patch: Record<string, unknown> = { attempts, last_error: errText.slice(0, 500) };
  if (attempts > BACKOFF_MIN.length) {
    patch.status = "dead";
  } else {
    patch.next_attempt_at = new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000).toISOString();
  }
  await admin.from("promnight_outbox").update(patch).eq("event_id", row.event_id);
  return false;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Interner Schutz: nur mit gültigem Secret (Cron/Server), fail-closed.
  if (!INTERNAL_SECRET || req.headers.get("X-CM-Internal") !== INTERNAL_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!WEBHOOK_SECRET) return json({ error: "PROMNIGHT_WEBHOOK_SECRET fehlt" }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await admin
    .from("promnight_outbox")
    .select("event_id, payload, attempts")
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (error) { console.error("Outbox-Abfrage", error); return json({ error: "db" }, 500); }

  let sent = 0, failed = 0;
  for (const row of rows ?? []) {
    if (await deliver(admin, row)) sent++; else failed++;
  }
  return json({ processed: (rows ?? []).length, sent, failed });
});
