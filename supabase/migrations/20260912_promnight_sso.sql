-- ============================================================
-- promnight ↔ Core Management  ·  SSO-Empfänger (Fassung 1.0)
-- ------------------------------------------------------------
-- Wir (Core Management) sind der EMPFÄNGER eines Ein-Weg-SSO.
-- promnight stellt ein kurzlebiges, signiertes JWT (RS256, 120 s)
-- aus; die Edge Function `sso-promnight` prüft es vollständig
-- (siehe Spec §7) und ruft danach die hier definierten Funktionen.
--
-- Grundsätze der Spec, die dieses Schema abbildet:
--   * Person wird über `sub` geführt (E-Mail ist KEIN Schlüssel, §9).
--   * Veranstaltung wird über `ball_id` geführt, nicht über Person.
--     Mehrere Komitee-Mitglieder (versch. sub, gleiche ball_id)
--     erhalten Zugriff auf DASSELBE Event.
--   * `jti` ist einmalig einlösbar (§7.7).
--   * Bestehendes Konto mit gleicher E-Mail, aber ohne sub, wird
--     NICHT automatisch verknüpft (§9) -> Bestätigungs-Flow.
--
-- Additiv & nicht brechend: nur neue Tabellen/Funktionen. Der
-- bestehende E-Mail-Login und die Mandanten-Policies bleiben
-- unverändert; wir hängen promnight-Mitglieder an das vorhandene
-- Modell (admins.role='organizer' + events.owner_email/event_owners).
-- ============================================================
begin;

create extension if not exists pgcrypto;

-- ---------- Person-Mapping: promnight `sub` -> Auth-User ----------
-- `sub` ist die stabile Kennung des Mitglieds bei promnight und
-- ändert sich nie (auch nicht bei E-Mail-Wechsel). Wir merken uns,
-- welcher Supabase-Auth-User dazugehört, plus die zuletzt vom Token
-- gelieferten Stammdaten (rein informativ / für Anzeige).
create table if not exists public.promnight_identities (
  sub        uuid primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  email      text not null,
  vorname    text,
  nachname   text,
  rolle      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists promnight_identities_user_idx  on public.promnight_identities (user_id);
create index if not exists promnight_identities_email_idx on public.promnight_identities (lower(email));

-- ---------- Veranstaltungs-Mapping: promnight `ball_id` -> Event ----------
create table if not exists public.promnight_balls (
  ball_id    uuid primary key,
  event_id   uuid not null references public.events(id) on delete cascade,
  slug       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists promnight_balls_event_idx on public.promnight_balls (event_id);

-- ---------- Einmal-Einlösung: `jti` ----------
-- Der Einmal-Schutz kann nur auf Empfängerseite wirken (Spec §7-Kasten).
-- Wir speichern jede eingelöste jti bis mindestens exp; ein zweiter
-- Aufruf mit gleicher jti scheitert am Primary Key.
create table if not exists public.promnight_jti (
  jti     uuid primary key,
  exp     timestamptz not null,
  seen_at timestamptz not null default now()
);
create index if not exists promnight_jti_exp_idx on public.promnight_jti (exp);

-- ---------- Verknüpfungs-Anfragen (Kollision gleiche E-Mail, §9) ----------
-- Existiert bereits ein Konto mit der Token-E-Mail, das noch nicht mit
-- diesem `sub` verknüpft ist, wird NICHT automatisch verknüpft. Stattdessen
-- legen wir eine kurzlebige Anfrage an; die Person muss sich mit genau dieser
-- E-Mail anmelden (Kontrolle nachweisen) und die Verknüpfung ausdrücklich
-- bestätigen. Die verifizierten Claims werden hier zwischengespeichert,
-- damit nach der Bestätigung ohne erneutes promnight-Token bereitgestellt
-- werden kann.
create table if not exists public.promnight_link_requests (
  token      uuid primary key default gen_random_uuid(),
  sub        uuid not null,
  email      text not null,
  claims     jsonb not null,
  exp        timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists promnight_link_requests_exp_idx on public.promnight_link_requests (exp);

-- Alle vier Tabellen enthalten interne Zuordnungsdaten und werden
-- ausschließlich von Edge Functions (service_role, umgeht RLS) bzw. der
-- unten definierten SECURITY-DEFINER-Funktion angefasst. RLS an, KEINE
-- Policies -> anon/authenticated haben keinen Direktzugriff.
alter table public.promnight_identities    enable row level security;
alter table public.promnight_balls         enable row level security;
alter table public.promnight_jti           enable row level security;
alter table public.promnight_link_requests enable row level security;

-- ============================================================
-- jti einmalig beanspruchen (atomar). true = neu (gültig),
-- false = bereits eingelöst (ablehnen wie abgelaufen, §10).
-- ============================================================
create or replace function public.promnight_claim_jti(p_jti uuid, p_exp timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from promnight_jti where exp < now();  -- opportunistische Aufräumung
  insert into promnight_jti (jti, exp) values (p_jti, p_exp);
  return true;
exception when unique_violation then
  return false;
end $$;

revoke all on function public.promnight_claim_jti(uuid, timestamptz) from public, anon, authenticated;

-- ============================================================
-- Bereitstellung nach erfolgreicher Token-Prüfung.
-- Legt/aktualisiert Identität, Event und Zugriff an und gibt die
-- event_id zurück. Wird von der Edge Function (service_role) mit
-- bereits VERIFIZIERTEN Claims aufgerufen sowie – nach der
-- Bestätigung – aus promnight_confirm_link().
--
-- p_user_id ist der Supabase-Auth-User, der die Person repräsentiert
-- (in der Edge Function via Admin-API sichergestellt).
-- ============================================================
create or replace function public.promnight_provision(
  p_sub               uuid,
  p_user_id           uuid,
  p_email             text,
  p_vorname           text,
  p_nachname          text,
  p_rolle             text,
  p_ball_id           uuid,
  p_ball_slug         text,
  p_schulname         text,
  p_ball_datum        date,
  p_veranstaltungsort text,
  p_stadt             text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_event uuid;
  v_owner text;
  v_name  text;
  v_loc   text;
begin
  if p_sub is null or p_user_id is null or v_email = '' or p_ball_id is null then
    raise exception 'promnight_provision: fehlende Pflichtangaben';
  end if;

  -- 1) Person <-> Auth-User (Zuordnung über sub, §9). E-Mail/Stammdaten
  --    aktualisieren; sub bleibt Schlüssel, auch wenn die E-Mail wechselt.
  insert into promnight_identities (sub, user_id, email, vorname, nachname, rolle)
    values (p_sub, p_user_id, v_email, p_vorname, p_nachname, p_rolle)
  on conflict (sub) do update
    set user_id = excluded.user_id,
        email   = excluded.email,
        vorname = excluded.vorname,
        nachname= excluded.nachname,
        rolle   = excluded.rolle,
        updated_at = now();

  -- 2) Veranstaltung <-> Ball (Zuordnung über ball_id). Beim ERSTEN Zugriff
  --    auf diesen Ball wird ein Event mit den Token-Stammdaten vorbefüllt und
  --    zunächst inaktiv angelegt (der Veranstalter finalisiert/aktiviert es im
  --    Dashboard). Danach immer dasselbe Event – auch für weitere Mitglieder.
  select event_id into v_event from promnight_balls where ball_id = p_ball_id;
  if v_event is null then
    v_name := coalesce(nullif(trim(p_schulname), ''), 'Ball');
    v_loc  := nullif(trim(both ', ' from
                concat_ws(', ', nullif(trim(p_veranstaltungsort), ''), nullif(trim(p_stadt), ''))), '');
    insert into events (name, date, location, description, active, owner_email)
      values (v_name,
              case when p_ball_datum is not null then p_ball_datum::timestamptz else null end,
              v_loc,
              'Automatisch über promnight angelegt – bitte im Dashboard prüfen und aktivieren.',
              false,
              v_email)
      returning id into v_event;
    insert into promnight_balls (ball_id, event_id, slug) values (p_ball_id, v_event, p_ball_slug);
  else
    update promnight_balls
       set slug = coalesce(p_ball_slug, slug), updated_at = now()
     where ball_id = p_ball_id;
  end if;

  -- 3) Dashboard-Zutritt: Mitglied als Veranstalter (organizer) führen.
  --    Bestehende Rolle (z. B. super_admin) NICHT herabstufen.
  insert into admins (email, role) values (v_email, 'organizer')
  on conflict (email) do nothing;

  -- 4) Event-Zugriff sicherstellen. Genau EIN Haupt-Veranstalter je Ball
  --    (dessen Stripe-Konto die Auszahlung erhält); weitere Mitglieder werden
  --    Mit-Veranstalter (event_owners), damit sie denselben Ball verwalten.
  select owner_email into v_owner from events where id = v_event;
  if v_owner is null then
    update events set owner_email = v_email where id = v_event;
  elsif lower(v_owner) <> v_email then
    insert into event_owners (event_id, email) values (v_event, v_email)
    on conflict (event_id, email) do nothing;
  end if;

  return jsonb_build_object('event_id', v_event);
end $$;

revoke all on function public.promnight_provision(
  uuid, uuid, text, text, text, text, uuid, text, text, date, text, text) from public, anon, authenticated;

-- ============================================================
-- Verknüpfung bestätigen (Kollisions-Flow, §9).
-- Wird vom BROWSER der bereits angemeldeten Person aufgerufen. Prüft, dass
-- die aktuelle Sitzung genau die E-Mail der Anfrage kontrolliert, und stellt
-- dann mit dem eigenen (bestehenden) Auth-Konto bereit. Danach ist die
-- Anfrage verbraucht.
-- ============================================================
create or replace function public.promnight_confirm_link(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r        promnight_link_requests;
  me       text := lower(coalesce(auth.jwt()->>'email',''));
  my_uid   uuid := auth.uid();
  c        jsonb;
  res      jsonb;
begin
  if my_uid is null or me = '' then
    raise exception 'Bitte zuerst anmelden.';
  end if;
  select * into r from promnight_link_requests where token = p_token;
  if not found then
    raise exception 'Verknüpfungs-Anfrage nicht gefunden oder bereits verwendet.';
  end if;
  if r.exp < now() then
    delete from promnight_link_requests where token = p_token;
    raise exception 'Die Verknüpfungs-Anfrage ist abgelaufen. Bitte den Vorgang in promnight neu starten.';
  end if;
  if lower(r.email) <> me then
    raise exception 'Diese Verknüpfung gehört zu einer anderen E-Mail-Adresse.';
  end if;

  c := r.claims;
  res := promnight_provision(
    r.sub, my_uid, me,
    c->>'vorname', c->>'nachname', c->>'rolle',
    (c->>'ball_id')::uuid, c->>'ball_slug',
    c->>'schulname',
    case when nullif(c->>'ball_datum','') is not null then (c->>'ball_datum')::date else null end,
    c->>'veranstaltungsort', c->>'stadt');

  delete from promnight_link_requests where token = p_token;
  return res;
end $$;

grant execute on function public.promnight_confirm_link(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
