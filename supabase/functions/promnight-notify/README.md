# Rückkanal an promnight (`promnight-notify`) – Spec §11

Zusteller der Outbox `promnight_outbox`. Sendet fällige Meldungen signiert an
promnight (HMAC-SHA256 über den Body, `X-CM-Signature`, plus `X-CM-Timestamp`),
mit Backoff 1/5/30 min, dann `dead`. Idempotenz über `event_id`.

Produzenten sind **DB-Trigger** (Migration `20260912_promnight_outbox.sql`):
- bezahlte Bestellung → `verkauf.aktualisiert` (+ `veranstaltung.ausverkauft`)
- Event erstmals aktiv → `setup.abgeschlossen`

`stripe-webhook` bleibt unverändert – die Trigger hängen an `orders`/`events`.

## 1. Migration einspielen
```bash
bash ../Focus-Events/tools/run-sql.sh --file supabase/migrations/20260912_promnight_outbox.sql
```

## 2. Function deployen (Florian; verify_jwt=false)
```powershell
cd "C:\Users\pustl\OneDrive\Desktop\Claude\Core-management.at"
$cred = "C:\Users\pustl\OneDrive\Desktop\Claude\CORE-CREDENTIALS.txt"
$sbp  = [regex]::Match((Get-Content $cred -Raw),'sbp_[A-Za-z0-9]+').Value
'{"entrypoint_path":"index.ts","verify_jwt":false}' | Out-File -Encoding ascii meta.json
curl.exe -s -X POST "https://api.supabase.com/v1/projects/xfdiuhmgkdujbjhdhvcw/functions/deploy?slug=promnight-notify" -H "Authorization: Bearer $sbp" -H "User-Agent: supabase-setup" -F "metadata=@meta.json;type=application/json" -F "file=@supabase/functions/promnight-notify/index.ts;type=application/typescript"
Remove-Item meta.json
```

## 3. Secrets (Supabase → Edge Functions → Secrets)
| Variable | Wert |
|---|---|
| `PROMNIGHT_WEBHOOK_SECRET` | **von promnight, Out-of-Band** (nicht per Doku) |
| `CM_INTERNAL_SECRET` | selbst erzeugen (z. B. `openssl rand -hex 32`) – schützt den Zusteller |
| `PROMNIGHT_WEBHOOK_URL` | optional, Default `https://www.promnight.at/api/webhooks/core-management` |

## 4. Cron minütlich (pg_cron + pg_net)
Einmalig in der DB einrichten (Extensions vorher unter Database → Extensions
aktivieren: `pg_cron`, `pg_net`). `<CM_INTERNAL_SECRET>` einsetzen:
```sql
select cron.schedule('promnight-outbox-flush', '* * * * *', $$
  select net.http_post(
    url     := 'https://xfdiuhmgkdujbjhdhvcw.supabase.co/functions/v1/promnight-notify',
    headers := '{"Content-Type":"application/json","X-CM-Internal":"<CM_INTERNAL_SECRET>"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);
```
Alternativ das Supabase-Dashboard → **Cron** nutzen und die Function minütlich
mit demselben Header aufrufen.

Manueller Test (löst sofortige Zustellung fälliger Zeilen aus):
```bash
curl -s -X POST "https://xfdiuhmgkdujbjhdhvcw.supabase.co/functions/v1/promnight-notify" \
  -H "X-CM-Internal: <CM_INTERNAL_SECRET>" -H "Content-Type: application/json" -d '{}'
```

## Body-Format (§11)
```json
{ "event_id": "…", "event": "verkauf.aktualisiert", "ball_id": "…",
  "ball_slug": "…", "stand": "2026-09-12T18:00:00Z",
  "tickets_verkauft": 342, "tickets_gesamt": 600 }
```
`tickets_verkauft` = bezahlte Tickets, `tickets_gesamt` = Summe der Kontingente.

## Mit promnight zu klären
- **Secret** (Out-of-Band-Kanal).
- Ob `ball_slug` erwünscht ist oder weggelassen werden soll.
- Genaues Zeitfenster/Verhalten bei `veranstaltung.ausverkauft`.
