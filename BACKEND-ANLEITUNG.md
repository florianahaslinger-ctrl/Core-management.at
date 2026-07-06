# CORE Management Ticketshop – Backend einrichten (Supabase + Stripe)

Mit dem Backend werden Bestellungen **zentral in einer Datenbank** gespeichert (auf jedem Gerät sichtbar),
Verifizierungscodes von Supabase **per E-Mail** versendet und Zahlungen über **Stripe-Checkout** abgewickelt –
Tickets werden **erst nach serverseitig verifizierter Zahlung (Webhook)** freigeschaltet und sind damit fälschungssicher.

Solange in `assets/config.js` nichts eingetragen ist, läuft der Shop weiter im lokalen Demo-Modus.

---

## Schritt 1: Supabase-Projekt erstellen (kostenlos)

1. Auf [supabase.com](https://supabase.com) registrieren → **New project** (Region z. B. *Central EU (Frankfurt)*).
2. Nach dem Erstellen unter **Project Settings → API** zwei Werte kopieren:
   - **Project URL** (z. B. `https://abcdefgh.supabase.co`)
   - **anon public key** (langer `eyJ…`-Schlüssel)

## Schritt 2: Datenbank anlegen

1. Im Supabase-Dashboard links **SQL Editor** öffnen.
2. Den kompletten Inhalt von **`supabase/schema.sql`** (aus diesem Repository) einfügen und **Run** klicken.
3. Dich selbst als Admin eintragen (eigene E-Mail einsetzen):
   ```sql
   insert into public.admins (email) values ('deine@email.at');
   ```

## Schritt 3: E-Mail-Codes aktivieren

1. **Authentication → Sign In / Up → Email**: eingeschaltet lassen; „Confirm email“ kann aus bleiben.
2. **Authentication → Emails → Templates → Magic Link**: Im Template den Platzhalter
   `{{ .Token }}` einbauen, z. B.:
   ```html
   <h2>Dein Verifizierungscode</h2>
   <p>Gib diesen Code im Ticketshop ein: <strong>{{ .Token }}</strong></p>
   <p>Der Code ist 60 Minuten gültig.</p>
   ```
   (Ohne diese Änderung schickt Supabase nur einen Link statt eines Codes.)
3. Hinweis: Der eingebaute Supabase-Mailer ist für den Start ausreichend, hat aber ein niedriges Limit
   (wenige Mails/Stunde). Für den echten Verkauf unter **Authentication → SMTP Settings** einen eigenen
   SMTP-Server hinterlegen (z. B. Gmail, Brevo – kostenlos).

## Schritt 4: Edge Functions deployen

Am einfachsten über die [Supabase CLI](https://supabase.com/docs/guides/functions/quickstart)
(einmalig `npm i -g supabase`), im Repository-Ordner:

```bash
supabase login
supabase link --project-ref <PROJECT_REF>        # steht in der Project URL
supabase functions deploy place-order
supabase functions deploy stripe-webhook --no-verify-jwt
```

> **Wichtig:** `stripe-webhook` unbedingt mit `--no-verify-jwt` deployen (Stripe hat keinen Supabase-Login).
> Alternativ im Dashboard unter *Edge Functions → stripe-webhook → Details* „Verify JWT“ ausschalten.

Ohne CLI geht es auch im Dashboard: **Edge Functions → Deploy a new function**, Name exakt
`place-order` bzw. `stripe-webhook`, Code aus `supabase/functions/<name>/index.ts` einfügen.

## Schritt 5: Stripe verbinden

1. Auf [stripe.com](https://stripe.com) registrieren (zum Testen reicht der **Test-Modus**).
2. **Entwickler → API-Schlüssel** → **Geheimschlüssel** (`sk_test_…` bzw. `sk_live_…`) kopieren.
3. **Entwickler → Webhooks → Endpoint hinzufügen**:
   - **URL:** `https://<PROJECT_REF>.supabase.co/functions/v1/stripe-webhook`
   - **Ereignisse:** `checkout.session.completed` und `checkout.session.expired`
   - Nach dem Anlegen das **Signing Secret** (`whsec_…`) kopieren.
4. Im Supabase-Dashboard unter **Edge Functions → Secrets** drei Secrets anlegen:
   | Name | Wert |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_…` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` |
   | `SITE_URL` | `https://core-management.at` |

## Schritt 6: Shop scharf schalten

In **`assets/config.js`** die beiden Werte aus Schritt 1 eintragen und die Datei ins Repository pushen:

```js
window.CM_CONFIG = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseAnonKey: 'eyJ…'
};
```

Der `anon key` ist öffentlich gedacht – alle Daten sind durch Row-Level-Security geschützt
(Käufer:innen sehen nur eigene Bestellungen, schreiben können nur Admins bzw. die Serverfunktionen).

## Schritt 7: Testen

1. `tickets.html` öffnen → Event sollte aus der Datenbank kommen (zuerst im Dashboard eines anlegen).
2. Tickets in den Warenkorb → *Zur Kassa* → E-Mail-Code → **„Weiter zur Online-Zahlung“** → Stripe-Testkarte
   `4242 4242 4242 4242` (beliebiges Zukunftsdatum / CVC) → Rückkehr in den Shop → Tickets mit QR + PDF.
3. `dashboard.html` → Anmeldung mit deiner Admin-E-Mail → Bestellung erscheint als **bezahlt · online**.

---

## Betrieb

- **Admins verwalten:** `insert into admins (email) values ('…');` bzw. `delete from admins where email = '…';` im SQL Editor.
- **Manuelle Zahlungen** (Überweisung/Abendkassa) funktionieren weiter: Bestellung bleibt *offen*,
  im Dashboard *als bezahlt markieren*.
- **Online-Zahlung ab-/anschalten:** im SQL Editor
  `update settings set value = 'false' where key = 'stripe_enabled';` (bzw. `'true'`).
- **Test- vs. Live-Modus:** Für den echten Verkauf in Stripe auf Live umstellen und `STRIPE_SECRET_KEY`
  + `STRIPE_WEBHOOK_SECRET` (neuer Live-Webhook!) in den Supabase-Secrets austauschen.
- Nicht abgeschlossene Stripe-Zahlungen laufen nach ca. 24 h ab; der Webhook `checkout.session.expired`
  storniert die Bestellung automatisch und gibt das Kontingent frei.
