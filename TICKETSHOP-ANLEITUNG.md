# CORE Management – Ticketshop-Anleitung

## Überblick

Der Ticketshop besteht aus zwei Seiten im Design der Hauptseite:

| Seite | Zweck |
|---|---|
| `tickets.html` | Öffentlicher Shop: Tickets auswählen, mit E-Mail + Verifizierungscode anmelden, bestellen, eigene Tickets mit QR-Code ansehen |
| `dashboard.html` | Adminbereich (PIN-geschützt): Statistiken & Diagramme, Events & Ticketkategorien verwalten, Bestellungen, Check-in, Einstellungen |

**Empfohlen: Backend-Modus (Supabase + Stripe).** Mit dem Backend werden Bestellungen zentral gespeichert,
E-Mail-Codes automatisch versendet und Zahlungen fälschungssicher per Stripe-Webhook bestätigt –
Einrichtung siehe **`BACKEND-ANLEITUNG.md`**. Ohne Backend-Konfiguration (in `assets/config.js`) läuft der Shop
im lokalen Demo-Modus: alle Daten liegen dann nur im `localStorage` des jeweiligen Browsers, und es gelten
die Hinweise weiter unten in dieser Datei (EmailJS, Payment Links, PIN).

## Erste Schritte

1. **Dashboard öffnen:** `core-management.at/dashboard.html`
2. **Standard-PIN:** `2468` → bitte sofort unter *Einstellungen → Admin-PIN ändern* ersetzen.
3. **Events anlegen:** Tab *Events & Tickets* → *+ Neues Event*. Pro Event beliebig viele Ticketkategorien
   (Name, Preis, Kontingent, Max. pro Bestellung, Beschreibung, aktiv/inaktiv). Alles ist jederzeit modular umstellbar.
4. Ein Demo-Event („Schulball 2026“) ist beim ersten Aufruf vorangelegt und kann bearbeitet oder gelöscht werden.

## E-Mail-Verifizierung einrichten (EmailJS)

Ohne Konfiguration läuft der Shop im **Demo-Modus**: Der 6-stellige Code wird direkt im Browser angezeigt
(mit deutlichem Hinweis). Für echten E-Mail-Versand:

1. Kostenloses Konto auf [emailjs.com](https://www.emailjs.com) anlegen (200 E-Mails/Monat gratis).
2. Unter *Email Services* einen Dienst verbinden (z. B. Gmail) → **Service-ID** notieren.
3. Unter *Email Templates* ein Template anlegen:
   - **To Email:** `{{to_email}}`
   - **Subject:** `{{subject}}`
   - **Inhalt:** z. B. `{{message}}` – der Code steht zusätzlich in `{{passcode}}`.
   - **Template-ID** notieren.
4. Unter *Account → General* den **Public Key** kopieren.
5. Alle drei Werte im Dashboard unter *Einstellungen → E-Mail-Versand* eintragen, speichern
   und mit *Test-E-Mail senden* prüfen.

Danach erhalten Käufer:innen Verifizierungscodes und Bestellbestätigungen per E-Mail.

## Online-Zahlung einrichten (Stripe Payment Links)

Damit Käufer:innen **direkt online bezahlen müssen**, bevor sie ihre Tickets bekommen:

1. Kostenloses Konto auf [stripe.com](https://stripe.com) erstellen (keine Fixkosten, Gebühr pro Transaktion).
2. Im Stripe-Dashboard unter *Produktkatalog* für **jede Ticketkategorie ein Produkt** mit dem passenden Preis anlegen (z. B. „Schulball 2026 – VIP“, 59 €).
3. Unter *Zahlungslinks* pro Produkt einen **Payment Link** erstellen:
   - **„Kunden können Menge anpassen“ aktivieren** (damit mehrere Tickets auf einmal bezahlt werden können).
   - Unter *Nach der Zahlung* → **„Kunden zu Ihrer Website weiterleiten“**: `https://core-management.at/tickets.html?paid=1`
4. Den Link (`https://buy.stripe.com/…`) im Ticketshop-Dashboard unter *Events & Tickets → Bearbeiten* in das Feld
   **„Stripe Payment-Link“** der jeweiligen Kategorie einfügen.

**Ablauf für Kund:innen:** Tickets wählen → E-Mail-Verifizierung → „Weiter zur Online-Zahlung“ → Stripe-Bezahlseite
(Kreditkarte, Apple Pay, Google Pay, Klarna u. a.) → automatische Rückkehr in den Shop → **Tickets sofort gültig**,
QR-Code sichtbar und PDF-Download verfügbar. Wird die Zahlung abgebrochen, bleibt die Bestellung offen und kann
unter *Meine Tickets* über **„Jetzt online bezahlen“** abgeschlossen werden.

Hinweise:
- Bei Online-Zahlung kann pro Bestellung nur **eine Ticketkategorie** gewählt werden (Stripe-Bezahlseite = ein Produkt).
  Mehrere Tickets derselben Kategorie sind kein Problem.
- Kategorien **ohne** Payment-Link laufen weiterhin über den manuellen Weg (Reservierung → Überweisung/Abendkassa → im Dashboard „als bezahlt markieren“).
- **Kontrolle:** Die Freischaltung nach Zahlung passiert im Browser der Kund:innen (statisches Hosting, kein Server).
  Gleiche daher Online-Bestellungen regelmäßig mit dem Stripe-Dashboard ab – dort steht bei jeder Zahlung die Bestellnummer
  (als *client_reference_id*). Für eine fälschungssichere, vollautomatische Bestätigung wäre ein kleines Backend mit
  Stripe-Webhooks nötig; das lässt sich später ergänzen.

## Ablauf für Käufer:innen (Zahlung vor Ticketfreigabe)

1. Tickets auf `tickets.html` auswählen → *Zur Kassa*.
2. E-Mail-Adresse eingeben → 6-stelliger Code kommt per E-Mail (10 Minuten gültig, max. 5 Versuche, 60 s Sperre zwischen Sendungen).
3. Code eingeben → Bestellung abschließen. Die Tickets sind jetzt **reserviert** (Status *offen*),
   aber **noch nicht gültig** – es gibt noch keinen QR-Code und kein PDF.
4. Zahlung erfolgt laut Checkout-Hinweis (z. B. Überweisung oder Abendkassa – Text im Dashboard einstellbar).
5. Im Dashboard unter *Bestellungen* die Bestellung **als bezahlt markieren** → erst dadurch werden die Tickets gültig.
   Ist EmailJS konfiguriert, bekommt der/die Käufer:in automatisch eine Zahlungsbestätigung per E-Mail.
6. Unter *Meine Tickets* erscheinen jetzt **QR-Code + klassischer Ticketcode** (beide gleichwertig),
   und die Tickets können als **PDF heruntergeladen** werden (eine Seite pro Ticket, mit QR-Code und Code zum Vorzeigen).
   Auch im Dashboard gibt es pro bezahlter Bestellung einen *Tickets-PDF*-Button.

**Wichtig:** Der Check-in akzeptiert nur Tickets aus bezahlten Bestellungen – unbezahlte oder stornierte Tickets werden abgewiesen.

## Dashboard-Funktionen

- **Übersicht:** Umsatz, verkaufte Tickets, Check-in-Quote, registrierte Käufer:innen;
  Diagramme (Verkäufe der letzten 14 Tage, Umsatz je Kategorie); Auslastung je Kontingent.
- **Events & Tickets:** Events und Kategorien anlegen, bearbeiten, aktivieren/deaktivieren, löschen.
- **Bestellungen:** Suchen/filtern, als *bezahlt* markieren, stornieren (Kontingent wird wieder frei), CSV-Export (Excel-kompatibel).
- **Check-in:** Ticketcode eingeben/scannen → Ticket wird entwertet; Doppel-Check-ins und stornierte Tickets werden abgewiesen.
- **Einstellungen:** EmailJS, Checkout-Hinweistext, Admin-PIN, Daten-Reset.

## Wichtige Einschränkungen (statisches Hosting)

- **Daten sind pro Browser/Gerät gespeichert.** Bestellungen, die Kund:innen auf ihren Geräten aufgeben,
  sind im Dashboard auf einem anderen Gerät **nicht** sichtbar. Für einen echten zentralen Verkauf braucht es
  ein Backend (z. B. Supabase/Firebase) oder einen Ticketing-Dienst – die Shop-Oberfläche ist dafür vorbereitet,
  da die gesamte Datenlogik in `assets/store.js` gekapselt ist.
- **Online-Zahlung über Stripe Payment Links** (siehe eigener Abschnitt oben). Kategorien ohne Payment-Link
  werden als *offen* angelegt; Zahlung z. B. per Überweisung oder Abendkassa, danach im Dashboard
  *als bezahlt markieren* – erst dann werden QR-Code und PDF freigeschaltet.
- **Die Admin-PIN ist Komfortschutz, keine echte Sicherheit** – der Quellcode ist öffentlich einsehbar.

## Dateien

- `tickets.html` + `assets/shop.js` – Shop
- `dashboard.html` + `assets/dashboard.js` – Dashboard
- `assets/store.js` – gesamte Daten- und E-Mail-Logik
- `assets/shop.css` – gemeinsames Design (Gold/Schwarz wie Hauptseite)
- `assets/qrcode.js` – QR-Code-Generator (MIT-Lizenz, lokal eingebunden – keine externen Abhängigkeiten)
- `assets/ticket-pdf.js` – PDF-Erzeugung der Tickets (ohne externe Bibliotheken)

<!-- Deploy-Marker: 2026-07-06T14:10:56Z -->
