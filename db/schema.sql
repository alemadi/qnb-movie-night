-- ============================================================================
-- QNB Movie Night — check-in database (Supabase / Postgres)
-- ----------------------------------------------------------------------------
-- Apply this file as-is to a fresh Supabase project (SQL editor or migration).
--
-- Security model:
--   * The browser only ever holds the public anon key.
--   * RLS is ENABLED on every table with NO anon/authenticated policies, so the
--     anon key cannot read or write any table directly (no guest list leak).
--   * All guest access goes through two SECURITY DEFINER RPCs — verify_guest()
--     and check_in() — which run as the function owner and bypass RLS in a
--     tightly controlled way. These are the only surface the public touches.
--   * The service-role key (importer only) bypasses RLS and never reaches the
--     browser or git.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists guests (
  id            bigint generated always as identity primary key,
  mobile        text        not null unique,                 -- normalised: last 8 digits
  name          text        not null,
  guest_count   int         not null default 1,              -- total party incl. the employee
  hall          text,                                        -- e.g. 'Hall 3' / 'Hall 4'
  status        text        not null default 'waitlist'
                            check (status in ('confirmed','waitlist')),
  ticket_token  uuid        not null default gen_random_uuid() unique,
  checked_in    boolean     not null default false,
  checked_in_at timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_guests_token on guests (ticket_token);

-- Single-row key/value config (holds the organizer PIN). The real PIN is set
-- out-of-band after deploy — never commit it here.
create table if not exists app_config (
  key   text primary key,
  value text not null
);

insert into app_config (key, value)
values ('organizer_pin', 'CHANGE_ME')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security — lock every table to the anon/authenticated roles.
-- (No policies are created, so PostgREST returns nothing for those roles.
--  The SECURITY DEFINER functions below are the only sanctioned access path.)
-- ---------------------------------------------------------------------------

alter table guests     enable row level security;
alter table app_config enable row level security;

revoke all on guests     from anon, authenticated;
revoke all on app_config from anon, authenticated;

-- ---------------------------------------------------------------------------
-- normalize_mobile(): strip every non-digit and keep the last 8 digits.
-- Same rule the JS importer must use so lookups always agree.
--   '+974 5512 3456' -> '55123456'   '0097455123456' -> '55123456'
-- ---------------------------------------------------------------------------

create or replace function normalize_mobile(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select right(regexp_replace(coalesce(p_raw, ''), '\D', '', 'g'), 8);
$$;

-- ---------------------------------------------------------------------------
-- verify_guest(p_mobile) -> guest-facing lookup for the verify/ticket screen.
--   { found, status, name, guest_count, hall, ticket_token, checked_in }
--   guest_count / hall / ticket_token are NULL unless status = 'confirmed'.
-- ---------------------------------------------------------------------------

create or replace function verify_guest(p_mobile text)
returns table (
  found        boolean,
  status       text,
  name         text,
  guest_count  int,
  hall         text,
  ticket_token uuid,
  checked_in   boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_norm text;
  g      guests%rowtype;
begin
  v_norm := normalize_mobile(p_mobile);

  if v_norm is null or length(v_norm) = 0 then
    return query select false, null::text, null::text, null::int, null::text, null::uuid, null::boolean;
    return;
  end if;

  select * into g from guests where mobile = v_norm limit 1;

  if not found then
    return query select false, null::text, null::text, null::int, null::text, null::uuid, null::boolean;
    return;
  end if;

  if g.status = 'confirmed' then
    return query select true, g.status, g.name, coalesce(g.confirmed_count, g.guest_count), g.hall, g.ticket_token, g.checked_in;
  else
    -- waitlist: no ticket, hall or party size exposed
    return query select true, g.status, g.name, null::int, null::text, null::uuid, g.checked_in;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- check_in(p_token, p_pin) -> organizer scanner. Atomic & idempotent.
--   { valid, authorized, already_checked_in, name, hall, guest_count, checked_in_at }
--   * wrong PIN            -> authorized=false (nothing else revealed)
--   * unknown/bad token    -> valid=false, authorized=true
--   * admitted just now    -> valid=true,  already_checked_in=false
--   * already checked in    -> valid=true,  already_checked_in=true (+ checked_in_at)
-- The UPDATE ... WHERE checked_in=false RETURNING makes a double-scan race safe:
-- only the first scan flips the row; the second falls through to "already".
-- ---------------------------------------------------------------------------

create or replace function check_in(p_token text, p_pin text)
returns table (
  valid              boolean,
  authorized         boolean,
  already_checked_in boolean,
  name               text,
  hall               text,
  guest_count        int,
  checked_in_at      timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pin   text;
  v_token uuid;
  g       guests%rowtype;
begin
  -- 1. PIN gate
  select value into v_pin from app_config where key = 'organizer_pin';
  if p_pin is null or v_pin is null or p_pin <> v_pin then
    return query select false, false, false, null::text, null::text, null::int, null::timestamptz;
    return;
  end if;

  -- 2. Parse token (malformed -> invalid, but authorized)
  begin
    v_token := p_token::uuid;
  exception when others then
    return query select false, true, false, null::text, null::text, null::int, null::timestamptz;
    return;
  end;

  -- 3. Atomic admit: only flips a confirmed, not-yet-checked-in row
  update guests
     set checked_in = true, checked_in_at = now()
   where ticket_token = v_token
     and status = 'confirmed'
     and checked_in = false
  returning * into g;

  if found then
    return query select true, true, false, g.name, g.hall, coalesce(g.confirmed_count, g.guest_count), g.checked_in_at;
    return;
  end if;

  -- 4. Not admitted now — either already checked in, or token not valid
  select * into g from guests where ticket_token = v_token and status = 'confirmed';

  if not found then
    return query select false, true, false, null::text, null::text, null::int, null::timestamptz;
    return;
  end if;

  return query select true, true, true, g.name, g.hall, coalesce(g.confirmed_count, g.guest_count), g.checked_in_at;
end;
$$;

-- Public (anon key) may only EXECUTE the two RPCs — nothing else.
revoke all on function verify_guest(text) from public;
revoke all on function check_in(text, text) from public;
grant execute on function verify_guest(text) to anon, authenticated;
grant execute on function check_in(text, text) to anon, authenticated;

-- ============================================================================
-- Day-of attendance confirmation + waitlist auto-promotion
-- ----------------------------------------------------------------------------
-- On the day of the event each confirmed guest is asked "are you coming?".
--   yes -> they get their QR ticket.
--   no  -> their seat is freed and the earliest-RSVP waitlister whose party
--          fits the freed seats is promoted into the same hall (and then gets
--          the same confirm step).
-- ============================================================================

alter table guests
  add column if not exists attendance             text check (attendance in ('yes','no')),
  add column if not exists attendance_at          timestamptz,
  add column if not exists confirm_sent_at        timestamptz,  -- when the day-of ask was sent
  add column if not exists promoted_from_waitlist boolean not null default false,
  add column if not exists promoted_at            timestamptz,
  add column if not exists wa_phone               text,          -- full WhatsApp number (cc+national)
  add column if not exists confirmed_count        int;           -- seats confirmed day-of (<= guest_count)

-- Qatari default for existing rows: 974 + last 8 digits.
update guests set wa_phone = '974' || mobile where wa_phone is null;

-- Read-only lookup so the confirm page can greet by name, render a seat picker
-- capped at the booked party size, and resume a prior answer.
create or replace function get_confirm_info(p_token text)
returns table (found boolean, name text, guest_count int, hall text, attendance text, confirmed_count int)
language plpgsql security definer set search_path = public as $$
declare v_token uuid; g guests%rowtype;
begin
  begin v_token := p_token::uuid; exception when others then
    return query select false,null::text,null::int,null::text,null::text,null::int; return;
  end;
  select * into g from guests gr where gr.ticket_token = v_token and gr.status = 'confirmed';
  if not found then
    return query select false,null::text,null::int,null::text,null::text,null::int; return;
  end if;
  return query select true, g.name, g.guest_count, g.hall, g.attendance, g.confirmed_count;
end; $$;

-- confirm_attendance(token, 'yes'|'no', seats?)
--   yes + seats -> attend with that many (clamped 1..booked); free the rest.
--   no          -> free all booked seats.
--   Any freed seats promote the earliest-RSVP waitlister who fits them
--   (FOR UPDATE SKIP LOCKED so concurrent declines never double-promote).
--   Idempotent: a second answer returns the existing state, no re-promotion.
create or replace function confirm_attendance(p_token text, p_answer text, p_seats int default null)
returns table (
  ok                   boolean,
  result               text,    -- 'confirmed_yes' | 'declined' | 'invalid'
  name                 text,
  hall                 text,
  guest_count          int,     -- the CONFIRMED count on 'yes'
  ticket_token         uuid,    -- non-null only for 'yes' (their QR)
  promoted_found       boolean,
  promoted_token       uuid,
  promoted_name        text,
  promoted_wa_phone    text,
  promoted_hall        text,
  promoted_guest_count int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid;
  v_ans   text;
  g       guests%rowtype;
  w       guests%rowtype;
  v_seats int;
  v_freed int;
begin
  v_ans := lower(trim(coalesce(p_answer, '')));
  if v_ans not in ('yes', 'no') then
    return query select false,'invalid',null::text,null::text,null::int,null::uuid,false,null::uuid,null::text,null::text,null::text,null::int;
    return;
  end if;

  begin
    v_token := p_token::uuid;
  exception when others then
    return query select false,'invalid',null::text,null::text,null::int,null::uuid,false,null::uuid,null::text,null::text,null::text,null::int;
    return;
  end;

  select * into g from guests gr where gr.ticket_token = v_token and gr.status = 'confirmed' for update;
  if not found then
    return query select false,'invalid',null::text,null::text,null::int,null::uuid,false,null::uuid,null::text,null::text,null::text,null::int;
    return;
  end if;

  -- Idempotent: already answered
  if g.attendance is not null then
    if g.attendance = 'yes' then
      return query select true,'confirmed_yes',g.name,g.hall,coalesce(g.confirmed_count,g.guest_count),g.ticket_token,false,null::uuid,null::text,null::text,null::text,null::int;
    else
      return query select true,'declined',g.name,g.hall,g.guest_count,null::uuid,false,null::uuid,null::text,null::text,null::text,null::int;
    end if;
    return;
  end if;

  if v_ans = 'yes' then
    v_seats := least(greatest(coalesce(p_seats, g.guest_count), 1), g.guest_count);
    update guests set attendance = 'yes', attendance_at = now(), confirmed_count = v_seats where id = g.id;
    v_freed := g.guest_count - v_seats;
  else
    update guests set attendance = 'no', attendance_at = now(), confirmed_count = 0 where id = g.id;
    v_freed := g.guest_count;
  end if;

  -- Promote one waitlister that fits the freed seats
  if v_freed > 0 then
    select * into w from guests gr
     where gr.status = 'waitlist'
       and gr.attendance is null
       and gr.guest_count <= v_freed
     order by gr.created_at asc
     for update skip locked
     limit 1;
    if found then
      update guests
         set status = 'confirmed', hall = g.hall,
             promoted_from_waitlist = true, promoted_at = now()
       where id = w.id;
    end if;
  end if;

  if v_ans = 'yes' then
    return query select true,'confirmed_yes',g.name,g.hall,v_seats,g.ticket_token,
                        (w.id is not null), w.ticket_token, w.name, w.wa_phone, g.hall, w.guest_count;
  else
    return query select true,'declined',g.name,g.hall,g.guest_count,null::uuid,
                        (w.id is not null), w.ticket_token, w.name, w.wa_phone, g.hall, w.guest_count;
  end if;
end;
$$;

revoke all on function get_confirm_info(text) from public;
revoke all on function confirm_attendance(text, text, int) from public;
grant execute on function get_confirm_info(text) to anon, authenticated;
grant execute on function confirm_attendance(text, text, int) to anon, authenticated;

-- ============================================================================
-- Hall assignment at the door (gate mode)
-- ----------------------------------------------------------------------------
-- Guests are imported with no pre-assigned hall; the scanner assigns Hall 3/4
-- when they check in. set_hall is PIN-gated and records the chosen hall.
-- ============================================================================
create or replace function set_hall(p_token text, p_pin text, p_hall text)
returns table (ok boolean, authorized boolean, name text, hall text)
language plpgsql security definer set search_path = public as $$
declare v_pin text; v_token uuid; g guests%rowtype;
begin
  select value into v_pin from app_config where key = 'organizer_pin';
  if p_pin is null or v_pin is null or p_pin <> v_pin then
    return query select false, false, null::text, null::text; return;
  end if;
  begin v_token := p_token::uuid; exception when others then
    return query select false, true, null::text, null::text; return;
  end;
  update guests set hall = p_hall where ticket_token = v_token and status = 'confirmed' returning * into g;
  if not found then
    return query select false, true, null::text, null::text; return;
  end if;
  return query select true, true, g.name, g.hall;
end; $$;

revoke all on function set_hall(text, text, text) from public;
grant execute on function set_hall(text, text, text) to anon, authenticated;
