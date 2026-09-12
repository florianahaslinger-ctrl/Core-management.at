// CORE Management Ticketshop – SSO-EMPFÄNGER für promnight (Spec Fassung 1.0)
// ---------------------------------------------------------------------------
// Landepunkt der Browser-Weiterleitung von promnight. Erhält das kurzlebige,
// RS256-signierte JWT als Query-Parameter `token`, prüft es VOLLSTÄNDIG nach
// Spec §7, legt Konto/Event an bzw. meldet an und leitet per 303 ins Dashboard
// weiter – ohne Token in der Ziel-URL.
//
// WICHTIG beim Deploy: verify_jwt = FALSE. Dies ist ein öffentlicher Endpunkt,
// der ein FREMDES (promnight-)Token entgegennimmt, KEIN Supabase-JWT.
//
// Der private Schlüssel liegt bei promnight; wir kennen nur den öffentlichen
// Schlüsselsatz (JWKS). Es werden keine Zugangsdaten ausgetauscht.
import { createClient } from "npm:@supabase/supabase-js@2";

// ----------------------------- Konfiguration -----------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Konstante, mit promnight vereinbarte Werte (per Env übersteuerbar).
const ISS = Deno.env.get("PROMNIGHT_ISS") ?? "https://www.promnight.at";
// aud wird HART geprüft. Exakter String ist mit promnight zu fixieren.
// Mehrere zulässige Werte kommasepariert (erleichtert Domain-Umstellung).
const AUD = (Deno.env.get("PROMNIGHT_AUD") ?? "https://core-management.at")
  .split(",").map((s) => s.trim()).filter(Boolean);
const JWKS_URL = Deno.env.get("PROMNIGHT_JWKS_URL") ?? "https://www.promnight.at/.well-known/jwks.json";

const DASHBOARD_URL = Deno.env.get("SSO_DASHBOARD_URL") ?? "https://core-management.at/dashboard.html";
const LINK_URL      = Deno.env.get("SSO_LINK_URL")      ?? "https://core-management.at/sso-verknuepfen.html";
const ERROR_URL     = Deno.env.get("SSO_ERROR_URL")     ?? "https://core-management.at/sso-fehler.html";

const SKEW = 60;              // zulässige Uhrenabweichung, Sekunden (§7.5)
const LINK_TTL_MIN = 15;      // Lebensdauer einer Verknüpfungs-Anfrage

// ----------------------------- Hilfen: base64url / JWT -----------------------------
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += "=".repeat(pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson(s: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

// ----------------------------- JWKS-Cache (§8) -----------------------------
// In-Memory-Cache je warmer Instanz: mind. 10 min nutzen, bei unbekanntem kid
// höchstens 1×/5 min nachladen, bei Ausfall zuletzt gültigen Stand bis 24 h.
let jwksKeys: any[] = [];
let jwksFetchedAt = 0;
let jwksLastTry = 0;
const MIN10 = 10 * 60 * 1000, MIN5 = 5 * 60 * 1000, H24 = 24 * 60 * 60 * 1000;

async function getSigningKey(kid: string): Promise<{ key: any; jwksUsable: boolean }> {
  const now = Date.now();
  const cacheAge = now - jwksFetchedAt;
  const usableCache = jwksKeys.length > 0 && cacheAge < H24;
  let key = usableCache ? jwksKeys.find((k) => k.kid === kid) : null;

  const stale = cacheAge > MIN10;
  const mayRefetch = (now - jwksLastTry) > MIN5;
  if (!key && (jwksKeys.length === 0 || stale) && (mayRefetch || jwksKeys.length === 0)) {
    jwksLastTry = now;
    try {
      const r = await fetch(JWKS_URL, { headers: { "Accept": "application/json" } });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j?.keys)) { jwksKeys = j.keys; jwksFetchedAt = now; }
      }
    } catch (_) { /* Fehler: zuletzt gültigen Stand weiterverwenden */ }
    key = (jwksKeys || []).find((k) => k.kid === kid) || null;
  }
  const jwksUsable = jwksKeys.length > 0 && (Date.now() - jwksFetchedAt) < H24;
  return { key, jwksUsable };
}

// ----------------------------- Ergebnis-Typen -----------------------------
type FailReason = "ungueltig" | "abgelaufen" | "abgelehnt" | "technik";
class Verify {
  static fail(reason: FailReason, detail: string): { ok: false; reason: FailReason; detail: string } {
    return { ok: false, reason, detail };
  }
}

// Vollständige Prüfung nach §7. Gibt bei Erfolg die Claims zurück, sonst einen
// Grund-Code (der Browser sieht KEINE technischen Details, §10).
async function verifyToken(token: string): Promise<
  { ok: true; claims: any } | { ok: false; reason: FailReason; detail: string }
> {
  const parts = token.split(".");
  if (parts.length !== 3) return Verify.fail("ungueltig", "kein kompaktes JWT");

  let header: any, payload: any;
  try { header = b64urlToJson(parts[0]); payload = b64urlToJson(parts[1]); }
  catch { return Verify.fail("ungueltig", "Header/Payload nicht dekodierbar"); }

  // §7.2 – Verfahren ist auf RS256 FESTGELEGT und wird NICHT aus dem Token
  // übernommen. alg:none oder symmetrische Verfahren werden abgelehnt.
  if (header.alg !== "RS256") return Verify.fail("ungueltig", `alg abgelehnt: ${header.alg}`);
  const kid = header.kid;
  if (!kid || typeof kid !== "string") return Verify.fail("ungueltig", "kid fehlt");

  // §7.1 – passenden Schlüssel aus dem JWKS holen.
  const { key: jwk, jwksUsable } = await getSigningKey(kid);
  if (!jwk) {
    // Unbekannte kid vs. JWKS gar nicht verfügbar unterscheiden (§10).
    return jwksUsable
      ? Verify.fail("ungueltig", `kid unbekannt: ${kid}`)
      : Verify.fail("technik", "JWKS nicht erreichbar und kein gültiger Cache");
  }

  // §7.2 – Signatur prüfen.
  let sigValid = false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    sigValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", cryptoKey, b64urlToBytes(parts[2]), signed,
    );
  } catch (e) {
    return Verify.fail("ungueltig", `Signaturprüfung fehlgeschlagen: ${e}`);
  }
  if (!sigValid) return Verify.fail("ungueltig", "Signatur ungültig");

  // §7.3 – iss
  if (payload.iss !== ISS) return Verify.fail("abgelehnt", `iss falsch: ${payload.iss}`);
  // §7.4 – aud (String oder Array)
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.some((a: string) => AUD.includes(a))
    : AUD.includes(payload.aud);
  if (!audOk) return Verify.fail("abgelehnt", `aud falsch: ${payload.aud}`);

  // §7.5 – exp in der Zukunft, iat nicht in der Zukunft (±60 s Skew)
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || now > payload.exp + SKEW)
    return Verify.fail("abgelaufen", "exp abgelaufen");
  if (typeof payload.iat !== "number" || payload.iat > now + SKEW)
    return Verify.fail("ungueltig", "iat in der Zukunft");

  // §7.6 – verifiziert muss true sein
  if (payload.verifiziert !== true) return Verify.fail("abgelehnt", "verifiziert !== true");

  // Pflichtfelder für die Bereitstellung
  if (!payload.sub || !payload.jti || !payload.ball_id || !payload.email)
    return Verify.fail("ungueltig", "Pflicht-Claims fehlen");

  return { ok: true, claims: payload };
}

// ----------------------------- Antworten -----------------------------
function redirect(url: string): Response {
  // 303: nach der Prüfung sofort ohne Token weiterleiten (§3.7).
  return new Response(null, { status: 303, headers: { "Location": url, "Cache-Control": "no-store" } });
}
function toError(reason: FailReason): Response {
  return redirect(`${ERROR_URL}?grund=${encodeURIComponent(reason)}`);
}

// ----------------------------- Sitzungs-Brücke -----------------------------
// Meldet den (bestehenden) Auth-User über einen einmaligen Magic-Link-Hash an
// und leitet ins Dashboard weiter. Nutzt exakt den vorhandenen Anmelde-
// mechanismus; die Ziel-URL enthält kein promnight-Token mehr.
async function bridgeSession(admin: any, email: string): Promise<Response> {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: DASHBOARD_URL },
  });
  if (error || !data?.properties?.action_link) {
    console.error("generateLink fehlgeschlagen", error);
    return toError("technik");
  }
  return redirect(data.properties.action_link);
}

// ----------------------------- Hauptablauf -----------------------------
Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return toError("ungueltig");

  // 1) Token vollständig prüfen (§7).
  const v = await verifyToken(token);
  if (!v.ok) { console.error("SSO-Prüfung fehlgeschlagen:", v.reason, v.detail); return toError(v.reason); }
  const c = v.claims;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // 2) jti einmalig beanspruchen (§7.7). Erst NACH erfolgreicher Prüfung.
  try {
    const exp = new Date(c.exp * 1000).toISOString();
    const { data: fresh, error } = await admin.rpc("promnight_claim_jti", { p_jti: c.jti, p_exp: exp });
    if (error) { console.error("claim_jti Fehler", error); return toError("technik"); }
    if (fresh !== true) return toError("abgelaufen"); // bereits eingelöst -> wie abgelaufen (§10)
  } catch (e) {
    console.error("claim_jti Ausnahme", e);
    return toError("technik");
  }

  const email = String(c.email).trim().toLowerCase();

  try {
    // 3) Person auflösen (Zuordnung über sub, §9).
    const { data: ident, error: identErr } = await admin
      .from("promnight_identities").select("user_id, email").eq("sub", c.sub).maybeSingle();
    if (identErr) { console.error("identities-Lookup", identErr); return toError("technik"); }

    let userId: string | null = ident?.user_id ?? null;
    let acctEmail = email; // E-Mail, unter der Konto geführt & angemeldet wird

    if (userId) {
      // Bekanntes Mitglied: bei E-Mail-Wechsel Auth-Konto nachziehen. Schlägt
      // das fehl (z. B. neue Adresse bereits vergeben), bleibt die zuletzt
      // gespeicherte E-Mail maßgeblich – Bereitstellung und Login konsistent.
      if (ident!.email?.toLowerCase() !== email) {
        const { error: upErr } = await admin.auth.admin.updateUserById(userId, {
          email, email_confirm: true,
        });
        if (upErr) { console.error("E-Mail-Update fehlgeschlagen (fahre fort)", upErr); acctEmail = ident!.email.toLowerCase(); }
      }
    } else {
      // Neuer sub: Konto anlegen versuchen. Existiert bereits eines mit dieser
      // E-Mail (createUser-Fehler), liegt eine KOLLISION vor -> nicht
      // automatisch verknüpfen (§9), sondern Bestätigungs-Flow.
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, email_confirm: true,
      });
      if (created?.user?.id) {
        userId = created.user.id;
      } else {
        const msg = String(createErr?.message ?? "").toLowerCase();
        const exists = msg.includes("already") || msg.includes("registered") ||
          msg.includes("exist") || (createErr as any)?.code === "email_exists";
        if (!exists) { console.error("createUser Fehler", createErr); return toError("technik"); }

        // Kollision: kurzlebige Verknüpfungs-Anfrage anlegen und dorthin leiten.
        const claims = {
          vorname: c.vorname ?? null, nachname: c.nachname ?? null, rolle: c.rolle ?? null,
          ball_id: c.ball_id, ball_slug: c.ball_slug ?? null, schulname: c.schulname ?? null,
          ball_datum: c.ball_datum ?? null, veranstaltungsort: c.veranstaltungsort ?? null,
          stadt: c.stadt ?? null,
        };
        const { data: lr, error: lrErr } = await admin.from("promnight_link_requests")
          .insert({
            sub: c.sub, email, claims,
            exp: new Date(Date.now() + LINK_TTL_MIN * 60 * 1000).toISOString(),
          }).select("token").single();
        if (lrErr || !lr?.token) { console.error("link_request Fehler", lrErr); return toError("technik"); }
        return redirect(`${LINK_URL}?req=${encodeURIComponent(lr.token)}`);
      }
    }

    // 4) Bereitstellen: Identität, Event (über ball_id) und Zugriff (§9).
    const ballDatum = c.ball_datum && /^\d{4}-\d{2}-\d{2}/.test(String(c.ball_datum))
      ? String(c.ball_datum).slice(0, 10) : null;
    const { error: provErr } = await admin.rpc("promnight_provision", {
      p_sub: c.sub, p_user_id: userId, p_email: acctEmail,
      p_vorname: c.vorname ?? null, p_nachname: c.nachname ?? null, p_rolle: c.rolle ?? null,
      p_ball_id: c.ball_id, p_ball_slug: c.ball_slug ?? null,
      p_schulname: c.schulname ?? null, p_ball_datum: ballDatum,
      p_veranstaltungsort: c.veranstaltungsort ?? null, p_stadt: c.stadt ?? null,
    });
    if (provErr) { console.error("provision Fehler", provErr); return toError("technik"); }

    // 5) Anmelden und ins Dashboard (ohne Token).
    return await bridgeSession(admin, acctEmail);
  } catch (e) {
    console.error("SSO-Ablauf Ausnahme", e);
    return toError("technik");
  }
});
