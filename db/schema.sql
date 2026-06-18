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
    return query select true, g.status, g.name, g.guest_count, g.hall, g.ticket_token, g.checked_in;
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
    return query select true, true, false, g.name, g.hall, g.guest_count, g.checked_in_at;
    return;
  end if;

  -- 4. Not admitted now — either already checked in, or token not valid
  select * into g from guests where ticket_token = v_token and status = 'confirmed';

  if not found then
    return query select false, true, false, null::text, null::text, null::int, null::timestamptz;
    return;
  end if;

  return query select true, true, true, g.name, g.hall, g.guest_count, g.checked_in_at;
end;
$$;

-- Public (anon key) may only EXECUTE the two RPCs — nothing else.
revoke all on function verify_guest(text) from public;
revoke all on function check_in(text, text) from public;
grant execute on function verify_guest(text) to anon, authenticated;
grant execute on function check_in(text, text) to anon, authenticated;
