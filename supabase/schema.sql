-- =========================================================
-- CORE Management Ticketshop – Supabase-Datenbankschema
-- Im Supabase-Dashboard unter "SQL Editor" einfügen und ausführen.
-- =========================================================

-- ---------- Tabellen ----------

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  date        timestamptz,
  location    text default '',
  description text default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.categories (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events(id) on delete cascade,
  name          text not null,
  price         numeric(10,2) not null default 0,
  quota         integer not null default 0,
  max_per_order integer not null default 10,
  description   text default '',
  active        boolean not null default true,
  sort          integer not null default 0
);

create table if not exists public.orders (
  id                text primary key,
  email             text not null,
  user_id           uuid references auth.users(id),
  status            text not null default 'offen' check (status in ('offen','bezahlt','storniert')),
  total             numeric(10,2) not null default 0,
  paid_via          text,
  paid_at           timestamptz,
  stripe_session_id text,
  created_at        timestamptz not null default now()
);

create table if not exists public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      text not null references public.orders(id) on delete cascade,
  category_id   uuid,
  category_name text not null,
  event_name    text not null,
  qty           integer not null,
  price         numeric(10,2) not null
);

create table if not exists public.tickets (
  code           text primary key,
  order_id       text not null references public.orders(id) on delete cascade,
  category_id    uuid,
  category_name  text not null,
  event_name     text not null,
  event_date     timestamptz,
  event_location text default '',
  price          numeric(10,2) not null default 0,
  checked_in     boolean not null default false,
  checked_in_at  timestamptz
);

create table if not exists public.admins (
  email      text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);

-- Standard-Einstellungen
insert into public.settings (key, value) values
  ('checkout_note', '"Die Tickets sind verbindlich reserviert. Zahlungsdetails erhaltet ihr per E-Mail bzw. an der Abendkassa."'),
  ('stripe_enabled', 'true')
on conflict (key) do nothing;

-- ---------- Hilfsfunktionen ----------

-- Ist der eingeloggte Benutzer Admin?
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- Verkaufte Stückzahlen je Kategorie (für Restkontingent im Shop, auch anonym abrufbar)
create or replace function public.category_sold()
returns table (category_id uuid, sold bigint)
language sql stable security definer set search_path = public
as $$
  select oi.category_id, coalesce(sum(oi.qty), 0)::bigint
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.status <> 'storniert'
  group by oi.category_id;
$$;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.category_sold() to anon, authenticated;

-- ---------- Row Level Security ----------

alter table public.events      enable row level security;
alter table public.categories  enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
alter table public.tickets     enable row level security;
alter table public.admins      enable row level security;
alter table public.settings    enable row level security;

-- Events & Kategorien: alle dürfen lesen, nur Admins schreiben
drop policy if exists events_read on public.events;
create policy events_read on public.events for select using (true);
drop policy if exists events_admin on public.events;
create policy events_admin on public.events for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select using (true);
drop policy if exists categories_admin on public.categories;
create policy categories_admin on public.categories for all using (public.is_admin()) with check (public.is_admin());

-- Bestellungen: Käufer sehen nur ihre eigenen, Admins alles.
-- Anlegen ausschließlich über die Edge Function (Service Role).
drop policy if exists orders_own on public.orders;
create policy orders_own on public.orders for select
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
drop policy if exists orders_admin on public.orders;
create policy orders_admin on public.orders for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists order_items_own on public.order_items;
create policy order_items_own on public.order_items for select
  using (exists (select 1 from public.orders o where o.id = order_id
                 and lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', ''))));
drop policy if exists order_items_admin on public.order_items;
create policy order_items_admin on public.order_items for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists tickets_own on public.tickets;
create policy tickets_own on public.tickets for select
  using (exists (select 1 from public.orders o where o.id = order_id
                 and lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', ''))));
drop policy if exists tickets_admin on public.tickets;
create policy tickets_admin on public.tickets for all using (public.is_admin()) with check (public.is_admin());

-- Admin-Liste: nur Admins dürfen sie sehen/ändern
drop policy if exists admins_admin on public.admins;
create policy admins_admin on public.admins for all using (public.is_admin()) with check (public.is_admin());

-- Einstellungen: lesen für alle, schreiben nur Admins
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select using (true);
drop policy if exists settings_admin on public.settings;
create policy settings_admin on public.settings for all using (public.is_admin()) with check (public.is_admin());

-- ---------- WICHTIG: ersten Admin eintragen ----------
-- Eigene E-Mail-Adresse hier einsetzen und ausführen:
-- insert into public.admins (email) values ('deine@email.at');
