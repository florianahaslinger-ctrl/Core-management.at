# CORE Management – Ticketshop-Anleitung

## Überblick

Der Ticketshop besteht aus zwei Seiten im Design der Hauptseite:

| Seite | Zweck |
|---|---|
| `tickets.html` | Öffentlicher Shop: Tickets auswählen, mit E-Mail + Verifizierungscode anmelden, bestellen, eigene Tickets mit QR-Code ansehen |
| `dashboard.html` | Adminbereich (PIN-geschützt): Statistiken & Diagramme, Events & Ticketkategorien verwalten, Bestellungen, Check-in, Einstellungen |

Der Shop läuft komplett im Browser (GitHub Pages ist statisches Hosting, es gibt keinen Server).
Alle Daten – Events, Bestellungen, Nutzer – werden im `localStorage` des jeweiligen Browsers gespeichert.

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

## Ablauf für Käufer:innen

1. Tickets auf `tickets.html` auswählen → *Zur Kassa*.
2. E-Mail-Adresse eingeben → 6-stelliger Code kommt per E-Mail (10 Minuten gültig, max. 5 Versuche, 60 s Sperre zwischen Sendungen).
3. Code eingeben → Bestellung abschließen.
4. Tickets mit QR-Code erscheinen unter *Meine Tickets* (gleicher Browser) und in der Bestätigungs-E-Mail.

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
- **Keine Online-Zahlung integriert.** Bestellungen werden als *offen* angelegt; Zahlung z. B. per Überweisung
  oder Abendkassa, danach im Dashboard *als bezahlt markieren*. (Stripe Payment Links lassen sich später ergänzen.)
- **Die Admin-PIN ist Komfortschutz, keine echte Sicherheit** – der Quellcode ist öffentlich einsehbar.

## Dateien

- `tickets.html` + `assets/shop.js` – Shop
- `dashboard.html` + `assets/dashboard.js` – Dashboard
- `assets/store.js` – gesamte Daten- und E-Mail-Logik
- `assets/shop.css` – gemeinsames Design (Gold/Schwarz wie Hauptseite)
