# SSO-Empfänger für promnight (`sso-promnight`)

Empfängt die Browser-Weiterleitung von promnight mit dem signierten JWT
(`?token=…`), prüft es vollständig nach der Spec (Fassung 1.0, §7), legt
Konto/Event an bzw. meldet an und leitet per **HTTP 303** ins Dashboard
weiter – ohne Token in der Ziel-URL.

Gehört zusammen mit:
- Migration `supabase/migrations/20260912_promnight_sso.sql`
- Seiten `sso-verknuepfen.html` (Kollisions-Bestätigung, §9) und `sso-fehler.html` (§10)

## 1. Migration einspielen (gemeinsame DB, Ref `xfdiuhmgkdujbjhdhvcw`)

> Achtung: dieselbe DB wird von CORE **und** Focus genutzt. Additiv/nicht
> brechend, aber trotzdem bewusst einspielen. Über den vorhandenen Helfer im
> Focus-Repo (liest den `sbp_`-Token aus `CORE-CREDENTIALS.txt`):

```bash
bash ../Focus-Events/tools/run-sql.sh --file supabase/migrations/20260912_promnight_sso.sql
```

oder den Inhalt im Supabase-Dashboard → SQL-Editor ausführen.

## 2. Edge Function deployen (muss Florian selbst ausführen)

**Wichtig: `verify_jwt = false`** – dies ist ein öffentlicher Endpunkt, der ein
FREMDES promnight-Token entgegennimmt, kein Supabase-JWT.

PowerShell:
```powershell
cd "C:\Users\pustl\OneDrive\Desktop\Claude\Core-management.at"
$cred = "C:\Users\pustl\OneDrive\Desktop\Claude\CORE-CREDENTIALS.txt"
$sbp  = [regex]::Match((Get-Content $cred -Raw),'sbp_[A-Za-z0-9]+').Value
'{"entrypoint_path":"index.ts","verify_jwt":false}' | Out-File -Encoding ascii meta.json
curl.exe -s -X POST "https://api.supabase.com/v1/projects/xfdiuhmgkdujbjhdhvcw/functions/deploy?slug=sso-promnight" `
  -H "Authorization: Bearer $sbp" -H "User-Agent: supabase-setup" `
  -F "metadata=@meta.json;type=application/json" `
  -F "file=@supabase/functions/sso-promnight/index.ts;type=application/typescript"
Remove-Item meta.json
```

## 3. Secrets / Konfiguration (Supabase → Functions → Secrets)

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` sind projektweit vorhanden.
Optional übersteuerbar (Defaults im Code):

| Variable | Default | Zweck |
|---|---|---|
| `PROMNIGHT_ISS` | `https://www.promnight.at` | erwarteter `iss` |
| `PROMNIGHT_AUD` | `https://core-management.at` | erwarteter `aud` (Komma-Liste erlaubt) |
| `PROMNIGHT_JWKS_URL` | `https://www.promnight.at/.well-known/jwks.json` | Schlüsselsatz |
| `SSO_DASHBOARD_URL` | `https://core-management.at/dashboard.html` | Ziel nach Login |
| `SSO_LINK_URL` | `https://core-management.at/sso-verknuepfen.html` | Kollisions-Bestätigung |
| `SSO_ERROR_URL` | `https://core-management.at/sso-fehler.html` | Fehlerseite |

## 4. Supabase Auth – Redirect-URLs freischalten

Unter Auth → URL Configuration → Redirect URLs müssen stehen:
- `https://core-management.at/dashboard.html`
- `https://core-management.at/sso-verknuepfen.html`

(sonst greift der Magic-Link-Redirect nach dem Login nicht).

## 5. Mit promnight zu fixieren

- **`aud`-String exakt**: promnight-Beispiel nennt `https://coremanagement.at`
  (ohne Bindestrich), unsere Domain ist `https://core-management.at`
  (mit Bindestrich). Einen der beiden Werte verbindlich vereinbaren; unser
  `PROMNIGHT_AUD` entsprechend setzen.
- **SSO-Einstieg (Prod)**, den promnight aufruft:
  `https://xfdiuhmgkdujbjhdhvcw.supabase.co/functions/v1/sso-promnight`
  (Token als Query-Parameter `token`). Für Test ggf. eigener Slug/Deploy.
- **`rolle`-Werteliste** (Spec „noch abzustimmen").

## Umgesetzte Prüfschritte (§7)

RS256 fest verdrahtet (kein Vertrauen auf Header-`alg`; `alg:none`/HS* abgelehnt) ·
`kid`→JWKS · Signatur · `iss` · `aud` · `exp`/`iat` (±60 s) · `verifiziert===true` ·
`jti` einmalig (Tabelle `promnight_jti`). JWKS-Cache 10 min–24 h, unbekannte `kid`
höchstens 1×/5 min nachladen, Ausfall → letzter Stand bis 24 h.

## Noch offen / später

- **Rückkanal §11** (wir POSTen `verkauf.aktualisiert` etc. an promnight, HMAC-
  SHA256, Secret Out-of-Band) – bewusst noch nicht gebaut.
- JWKS-Persistenz in der DB (statt nur In-Memory pro warmer Instanz) als
  Härtung des 24-h-Ausfallpuffers.
