-- ============================================================
-- promnight ↔ Core Management  ·  Rückkanal / Verkaufsstände (Spec §11)
-- ------------------------------------------------------------
-- Core Management meldet Änderungen an promnight:
--   setup.abgeschlossen · verkauf.aktualisiert · veranstaltung.ausverkauft
-- Zustellung: POST an promnight mit HMAC-SHA256 über den Body (§11).
--
-- Muster: ENTKOPPELTE OUTBOX. DB-Trigger schreiben Ereignisse in
-- `promnight_outbox` (Produzenten); die Edge Function `promnight-notify`
-- stellt sie zu (Konsument, per Cron minütlich, mit Backoff 1/5/30 min).
-- Vorteil: keine Änderung an stripe-webhook nötig; Zustellung überlebt
-- kurzzeitige Ausfälle bei promnight.
--
-- Nur Bälle, die über SSO aus promnight stammen (in promnight_balls),
-- lösen Meldungen aus. Additiv/nicht brechend.
-- ============================================================
begin;

create table if not exists public.promnight_outbox (
  event_id        uuid primary key default gen_random_uuid(),  -- Idempotenz-Schlüssel für promnight
  ball_id         uuid not null,
  kind            text not null check (kind in
                    ('setup.abgeschlossen','verkauf.aktualisiert','veranstaltung.ausverkauft')),
  payload         jsonb not null,          -- exakter Body, der signiert & gesendet wird
  status          text not null default 'queued' check (status in ('queued','delivered','dead')),
  attempts        int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index if not exists promnight_outbox_due_idx
  on public.promnight_outbox (next_attempt_at) where status = 'queued';
create index if not exists promnight_outbox_ball_idx on public.promnight_outbox (ball_id, kind);

-- Interne Tabelle: nur Edge Functions (service_role) / Trigger (definer).
alter table public.promnight_outbox enable row level security;

-- ------------------------------------------------------------
-- Eine Meldung in die Outbox legen. Baut den Body nach Spec §11 auf.
-- tickets_verkauft = bezahlte Tickets des Events; tickets_gesamt = Kapazität
-- (Summe der Kategorie-Kontingente). „ausverkauft" wird höchstens EINMAL je
-- Ball gemeldet (dedupliziert über bereits vorhandene Outbox-Zeilen).
-- ------------------------------------------------------------
create or replace function public.promnight_enqueue(p_ball_id uuid, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_event   uuid;
  v_slug    text;
  v_gesamt  int;
  v_verkauft int;
  v_id      uuid := gen_random_uuid();
begin
  select event_id, slug into v_event, v_slug from promnight_balls where ball_id = p_ball_id;
  if v_event is null then return; end if;

  select coalesce(sum(quota), 0) into v_gesamt from categories where event_id = v_event;
  select count(*) into v_verkauft
    from tickets t join orders o on o.id = t.order_id
   where o.event_id = v_event and o.status = 'bezahlt';

  -- „ausverkauft" nur einmal je Ball
  if p_kind = 'veranstaltung.ausverkauft'
     and exists (select 1 from promnight_outbox
                 where ball_id = p_ball_id and kind = 'veranstaltung.ausverkauft'
                   and status <> 'dead') then
    return;
  end if;

  insert into promnight_outbox (event_id, ball_id, kind, payload)
  values (v_id, p_ball_id, p_kind, jsonb_build_object(
    'event_id', v_id::text,
    'event',    p_kind,
    'ball_id',  p_ball_id::text,
    'ball_slug', v_slug,
    'stand',    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'tickets_verkauft', v_verkauft,
    'tickets_gesamt',   v_gesamt
  ));
end $$;

revoke all on function public.promnight_enqueue(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- Auslöser 1: bezahlte Bestellung -> verkauf.aktualisiert (+ ggf. ausverkauft)
-- ------------------------------------------------------------
create or replace function public.promnight_on_order_paid()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ball uuid;
  v_gesamt int;
  v_verkauft int;
  v_event uuid;
begin
  if NEW.status = 'bezahlt'
     and coalesce(OLD.status, '') <> 'bezahlt'
     and NEW.event_id is not null then
    select ball_id into v_ball from promnight_balls where event_id = NEW.event_id;
    if v_ball is not null then
      perform promnight_enqueue(v_ball, 'verkauf.aktualisiert');
      -- Ausverkauft prüfen
      v_event := NEW.event_id;
      select coalesce(sum(quota), 0) into v_gesamt from categories where event_id = v_event;
      select count(*) into v_verkauft
        from tickets t join orders o on o.id = t.order_id
       where o.event_id = v_event and o.status = 'bezahlt';
      if v_gesamt > 0 and v_verkauft >= v_gesamt then
        perform promnight_enqueue(v_ball, 'veranstaltung.ausverkauft');
      end if;
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists promnight_orders_paid on public.orders;
create trigger promnight_orders_paid
  after insert or update of status on public.orders
  for each row execute function public.promnight_on_order_paid();

-- ------------------------------------------------------------
-- Auslöser 2: Event wird erstmals aktiv -> setup.abgeschlossen
-- ------------------------------------------------------------
create or replace function public.promnight_on_event_active()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ball uuid;
begin
  if NEW.active and not coalesce(OLD.active, false) then
    select ball_id into v_ball from promnight_balls where event_id = NEW.id;
    if v_ball is not null
       and not exists (select 1 from promnight_outbox
                       where ball_id = v_ball and kind = 'setup.abgeschlossen' and status <> 'dead') then
      perform promnight_enqueue(v_ball, 'setup.abgeschlossen');
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists promnight_events_active on public.events;
create trigger promnight_events_active
  after update of active on public.events
  for each row execute function public.promnight_on_event_active();

notify pgrst, 'reload schema';
commit;
