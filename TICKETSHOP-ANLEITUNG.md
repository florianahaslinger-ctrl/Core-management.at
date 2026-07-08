# CORE Management – Ticketshop-Anleitung

## Überblick

Der Ticketshop ist ein vollwertiger Onlineshop mit zentraler Datenbank und echter Online-Zahlung:

| Seite | Zweck |
|---|---|
| `tickets.html` | Öffentlicher Shop: Tickets auswählen, Anmeldung per E-Mail-Verifizierung, Online-Zahlung über Stripe, eigene Tickets mit QR-Code ansehen und als PDF laden |
| `dashboard.html` | Adminbereich: Statistiken & Diagramme, Events & Ticketkategorien verwalten, Bestellungen, Check-in, Admin-Verwaltung |

**Architektur:**
- **Supabase** (Projekt „Ticketsystem“): zentrale Datenbank für Events, Kategorien, Bestellungen und Tickets;
  E-Mail-Login mit Verifizierung; Zugriffsschutz über Row Level Security.
- **Stripe Checkout:** Käufer:innen zahlen auf der sicheren Stripe-Bezahlseite (Kreditkarte, Apple Pay, Google Pay u. a.).
  Ein **Webhook bestätigt die Zahlung serverseitig** – erst dann werden die Tickets erzeugt und freigeschaltet.
  Fälschen der „Zahlung erfolgreich“-Rückkehr bringt nichts: ohne bestätigte Stripe-Zahlung gibt es keine Tickets.
- Der geheime Stripe-Schlüssel liegt ausschließlich in den Supabase-Edge-Functions (Server), niemals im öffentlichen Code.

## Kaufablauf

1. Tickets auf `tickets.html` wählen → *Zur Kassa*.
2. E-Mail-Adresse eingeben → Supabase sendet eine Anmelde-E-Mail (Link anklicken oder Code eingeben).
3. *Weiter zur Online-Zahlung* → Stripe-Bezahlseite → zahlen.
4. Automatische Rückkehr in den Shop: Tickets sind sofort gültig – mit **QR-Code + klassischem Ticketcode**
   und **PDF-Download** (eine Seite pro Ticket).
5. Abgebrochene Zahlungen erzeugen keine Tickets; die Bestellung bleibt als „offen“ sichtbar und kann einfach neu ausgelöst werden.

## Dashboard

Anmeldung mit einer **Admin-E-Mail-Adresse** (gleicher Login-Flow). Wer Admin ist, steht in der Datenbank –
verwaltbar im Dashboard unter *Einstellungen → Admins verwalten*. Erster Admin: `florian.a.haslinger@gmail.com`.

- **Übersicht:** Umsatz (nur bezahlte Bestellungen), verkaufte Tickets, Check-in-Quote; Diagramme; Auslastung je Kategorie.
- **Events & Tickets:** vollständig modular – Events und Kategorien anlegen, Preise/Kontingente ändern, aktivieren/deaktivieren, löschen.
- **Bestellungen:** suchen/filtern, CSV-Export, Tickets-PDF, stornieren (Kontingent wird frei; Rückerstattung im Stripe-Dashboard).
- **Check-in:** drei Wege, alle gleichwertig:
  1. **QR-Scanner im Dashboard** (Tab *Check-in* → „Kamera-Scan starten“): Handy/Laptop-Kamera scannt die Tickets, der Check-in passiert automatisch (mit Vibration als Rückmeldung am Handy).
  2. **Handy-Kamera direkt:** Der QR-Code auf jedem Ticket öffnet `ticket.html` mit der Gültigkeitsprüfung (Gültig / bereits eingecheckt / nicht bezahlt / storniert). Ist man im selben Browser als Admin angemeldet, erscheint dort ein „Jetzt einchecken“-Knopf.
  3. **Manuelle Eingabe** des Ticketcodes (CM-XXXX-XXXX).

  Unbezahlte, stornierte oder bereits entwertete Tickets werden immer abgewiesen; jede Entwertung ist einmalig.

## Wichtig für den echten Betrieb

1. **E-Mail-Versand (dringend empfohlen):** Ohne eigenen SMTP-Server verschickt Supabase nur **2 Anmelde-E-Mails pro Stunde** –
   für den Verkaufsstart zwingend ändern: Supabase-Dashboard → *Authentication → Emails → SMTP Settings* →
   kostenlosen Anbieter hinterlegen (z. B. Resend oder Brevo). Danach kann dort auch die E-Mail-Vorlage angepasst werden –
   mit `{{ .Token }}` steht der 6-stellige Code direkt in der E-Mail.
2. **Stripe:** Auszahlungen, Rückerstattungen und Belege im Stripe-Dashboard (dashboard.stripe.com).
   Bei jeder Zahlung steht die Bestellnummer als *client_reference_id*.
3. **Schlüssel geheim halten:** Der `sk_live_…`-Schlüssel und das Supabase-Access-Token gehören nirgendwo in den Code
   oder in Chats. Nach Einrichtung/Weitergabe: in Stripe rotieren (Entwickler → API-Schlüssel) und den neuen Wert als
   Secret `STRIPE_SECRET_KEY` in Supabase setzen (*Edge Functions → Secrets*).
4. Der im Frontend sichtbare Supabase-„anon“-Schlüssel ist **öffentlich vorgesehen** und durch Row Level Security abgesichert.

## Technische Komponenten

- `assets/store.js` – Datenschicht (Supabase-Client, Auth, Bestellungen, Admin-Funktionen)
- `assets/shop.js` / `assets/dashboard.js` – Seitenlogik
- `assets/supabase.js` – Supabase-JavaScript-Client (lokal eingebunden)
- `assets/qrcode.js` – QR-Code-Generator (MIT-Lizenz, lokal)
- `assets/ticket-pdf.js` – PDF-Erzeugung ohne externe Bibliotheken
- Supabase Edge Functions: `create-checkout` (legt Bestellung + Stripe-Session an, prüft Kontingente serverseitig),
  `stripe-webhook` (prüft die Stripe-Signatur, erzeugt Tickets nach bestätigter Zahlung)
- Stripe-Webhook: `checkout.session.completed` → `https://xfdiuhmgkdujbjhdhvcw.supabase.co/functions/v1/stripe-webhook`
