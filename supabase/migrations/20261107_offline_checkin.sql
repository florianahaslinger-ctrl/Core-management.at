-- ============================================================
-- Offline-Einlass für den Scanner (einlass.html)
-- ------------------------------------------------------------
-- 1) checkin_ticket_list: liefert (nur mit gültigem Einlass-Passwort) alle
--    gültigen Tickets des Events, damit der Scanner sie aufs Gerät laden und
--    ohne Internet prüfen kann. E-Mail wird maskiert (Datenschutz).
-- 2) checkin_sync_offline: übernimmt offline gescannte Check-ins nachträglich
--    (mit Scan-Zeitpunkt) und meldet Konflikte (z. B. bereits an einem anderen
--    Gerät eingecheckt) zurück.
-- ============================================================
begin;

create or replace function public.checkin_mask_email(p text) returns text
language sql immutable set search_path to 'public' as $$
  select case when p is null or position('@' in p) = 0 then null
    else left(split_part(p, '@', 1), 2) || '***@' || split_part(p, '@', 2) end;
$$;

create or replace function public.checkin_ticket_list(p_event uuid, p_password text) returns json
language plpgsql stable security definer set search_path to 'public', 'extensions' as $$
declare h text; e events;
begin
  select password_hash into h from event_checkin where event_id = p_event;
  if h is null or h <> crypt(coalesce(p_password, ''), h) then
    raise exception 'Falsches Einlass-Passwort.';
  end if;
  select * into e from events where id = p_event;
  return json_build_object(
    'event', e.name,
    'generated_at', now(),
    'tickets', coalesce((
      select json_agg(json_build_object(
        'code', t.code,
        'category', t.category_name,
        'seat', case when s.id is not null then 'Reihe ' || s.row_no || ' - Tisch ' || s.table_no || ' - Platz ' || s.seat_no end,
        'name', o.customer_name,
        'email', checkin_mask_email(o.email),
        'checked_in', t.checked_in,
        'checked_in_at', t.checked_in_at
      ) order by t.code)
      from tickets t
      join orders o on o.id = t.order_id
      left join seats s on s.id = t.seat_id
      where o.event_id = p_event and o.status = 'bezahlt'
    ), '[]'::json)
  );
end $$;
grant execute on function public.checkin_ticket_list(uuid, text) to anon, authenticated;

-- p_items: [{ "code": "CM-XXXX-XXXX", "at": "2026-11-07T21:04:00Z" }, …]
create or replace function public.checkin_sync_offline(p_event uuid, p_password text, p_items json) returns json
language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare h text; it json; v_code text; v_at timestamptz; t tickets; o orders; res json[] := '{}';
begin
  select password_hash into h from event_checkin where event_id = p_event;
  if h is null or h <> crypt(coalesce(p_password, ''), h) then
    raise exception 'Falsches Einlass-Passwort.';
  end if;
  for it in select * from json_array_elements(coalesce(p_items, '[]'::json)) loop
    v_code := upper(trim(it->>'code'));
    begin v_at := (it->>'at')::timestamptz; exception when others then v_at := now(); end;
    if v_at is null or v_at > now() then v_at := now(); end if;
    select * into t from tickets where code = v_code;
    if not found then
      res := res || json_build_object('code', v_code, 'status', 'unknown');
      continue;
    end if;
    select * into o from orders where id = t.order_id;
    if o.event_id is distinct from p_event or o.status <> 'bezahlt' then
      res := res || json_build_object('code', v_code, 'status', 'invalid', 'order_status', o.status);
      continue;
    end if;
    if t.checked_in then
      res := res || json_build_object('code', v_code, 'status', 'already', 'checked_in_at', t.checked_in_at);
      continue;
    end if;
    update tickets set checked_in = true, checked_in_at = v_at where code = v_code;
    res := res || json_build_object('code', v_code, 'status', 'ok');
  end loop;
  return array_to_json(res);
end $$;
grant execute on function public.checkin_sync_offline(uuid, text, json) to anon, authenticated;

commit;
