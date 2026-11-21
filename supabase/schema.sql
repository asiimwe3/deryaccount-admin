-- DeryAccount Admin — Supabase schema (v2)
--
-- Matches the EXACT snake_case payloads the Android sync engine pushes
-- (SyncEngine.saleWithItemsJson): id, receipt_no, branch_id, user_id,
-- customer_id, sale_type, subtotal, tax_total, discount, total, amount_paid,
-- change_given, payment_method, sold_at, shift_id, created_at, updated_at.
--
-- Design rules:
--   * Tills keep working offline. Nothing here is required for selling.
--   * Local SQLite is authoritative. This is a reporting mirror.
--   * Uploads are idempotent: primary key = the till's own UUID, and the apps
--     send Prefer: resolution=merge-duplicates, so a retry cannot duplicate.
--   * The dashboard is read-only: no policy grants UPDATE or DELETE on sales.
--   * No service_role key anywhere near the frontend.

create extension if not exists pgcrypto;

-- ── Businesses and owners ────────────────────────────────────────────────────
create table if not exists orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references orgs(id) on delete cascade,
  email       text,
  role        text not null default 'OWNER' check (role in ('OWNER','MANAGER','ACCOUNTANT')),
  created_at  timestamptz not null default now()
);

create index if not exists profiles_org_idx on profiles(org_id);

-- Resolves the caller's business. SECURITY DEFINER so policies can use it
-- without recursing into profiles' own RLS.
create or replace function current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from profiles where id = auth.uid() limit 1
$$;

-- ── Tills ────────────────────────────────────────────────────────────────────
-- One row per installed app. `token` is the device's upload credential: it is
-- checked in the INSERT policies below, so a stolen anon key alone cannot
-- inject sales. Rotate by updating the row.
create table if not exists devices (
  id            text primary key,              -- till's own device id (UUID)
  org_id        uuid not null references orgs(id) on delete cascade,
  branch_id     text,
  name          text,
  platform      text not null default 'android' check (platform in ('android','desktop','web')),
  app_version   text,
  token         text not null,
  last_seen_at  timestamptz,
  last_sync_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists devices_org_idx on devices(org_id);
create unique index if not exists devices_token_idx on devices(token);

create table if not exists branches (
  id          text primary key,
  org_id      uuid references orgs(id) on delete cascade,
  name        text,
  code        text,
  location    text,
  created_at  timestamptz,
  updated_at  timestamptz
);

create index if not exists branches_org_idx on branches(org_id);

-- Cashier names for the dashboard. The till pushes user_id; this table turns
-- that into a person without exposing any PIN material.
create table if not exists staff (
  id          text primary key,
  org_id      uuid references orgs(id) on delete cascade,
  branch_id   text,
  name        text,
  role        text,
  updated_at  timestamptz
);

-- ── Sales ────────────────────────────────────────────────────────────────────
create table if not exists sales (
  id              text primary key,            -- till's UUID: the idempotency key
  org_id          uuid references orgs(id) on delete cascade,
  branch_id       text,
  device_id       text references devices(id) on delete set null,
  platform        text,                        -- 'android' | 'desktop'
  receipt_no      text,
  user_id         text,
  customer_id     text,
  sale_type       text,
  subtotal        numeric(14,2) not null default 0,
  tax_total       numeric(14,2) not null default 0,
  discount        numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  amount_paid     numeric(14,2) not null default 0,
  change_given    numeric(14,2) not null default 0,
  payment_method  text,
  status          text not null default 'completed',
  sold_at         timestamptz,                 -- when the shop sold it (till clock)
  shift_id        text,
  created_at      timestamptz,
  updated_at      timestamptz,
  received_at     timestamptz not null default now()    -- when the cloud got it
  -- Deliberately NO unique(branch_id, receipt_no): a shop that resets its daily
  -- counter would otherwise have every later sale silently rejected on upload.
  -- Idempotency comes from the primary key (the till's own UUID) plus
  -- Prefer: resolution=merge-duplicates.
);

create index if not exists sales_sold_at_idx on sales(sold_at desc);
create index if not exists sales_org_sold_idx on sales(org_id, sold_at desc);
create index if not exists sales_branch_idx on sales(branch_id);
create index if not exists sales_device_idx on sales(device_id);
create index if not exists sales_platform_idx on sales(platform);

create table if not exists sale_items (
  id          text primary key,
  sale_id     text not null references sales(id) on delete cascade,
  product_id  text,
  name        text,
  qty         numeric(14,3) not null default 0,
  unit_price  numeric(14,2) not null default 0,
  cost_price  numeric(14,2) not null default 0,
  line_total  numeric(14,2) not null default 0
);

create index if not exists sale_items_sale_idx on sale_items(sale_id);

-- ── Sync bookkeeping ────────────────────────────────────────────────────────
-- Each upload attempt reports itself here, so the dashboard can show
-- "last sync", "pending" and "failed" per till instead of guessing.
create table if not exists sync_runs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references orgs(id) on delete cascade,
  device_id   text references devices(id) on delete set null,
  platform    text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  pushed      int not null default 0,
  pending     int not null default 0,
  ok          boolean not null default true,
  error       text
);

create index if not exists sync_runs_device_idx on sync_runs(device_id, started_at desc);

-- ── Reporting view (Uganda local days) ─────────────────────────────────────
-- Africa/Kampala is UTC+3 with no DST, so a shop's "day" is 21:00 UTC previous
-- day to 21:00 UTC. Doing it here keeps the dashboard and the books agreeing.
create or replace view daily_sales
with (security_invoker = true) as
select
  org_id,
  branch_id,
  platform,
  (sold_at at time zone 'Africa/Kampala')::date as business_date,
  count(*)                        as tickets,
  sum(total)                      as revenue,
  sum(tax_total)                  as vat,
  sum(discount)                   as discounts
from sales
group by org_id, branch_id, platform, (sold_at at time zone 'Africa/Kampala')::date;

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table orgs       enable row level security;
alter table profiles   enable row level security;
alter table devices    enable row level security;
alter table branches   enable row level security;
alter table staff      enable row level security;
alter table sales      enable row level security;
alter table sale_items enable row level security;
alter table sync_runs  enable row level security;

-- Owners read their own business. Read-only: no UPDATE/DELETE policies exist
-- for sales, so the dashboard physically cannot alter a transaction.
drop policy if exists org_read on orgs;
create policy org_read on orgs for select to authenticated
  using (id = current_org_id());

drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles for select to authenticated
  using (id = auth.uid() or org_id = current_org_id());

drop policy if exists devices_read on devices;
create policy devices_read on devices for select to authenticated
  using (org_id = current_org_id());

drop policy if exists branches_read on branches;
create policy branches_read on branches for select to authenticated
  using (org_id = current_org_id());

drop policy if exists staff_read on staff;
create policy staff_read on staff for select to authenticated
  using (org_id = current_org_id());

drop policy if exists sales_read on sales;
create policy sales_read on sales for select to authenticated
  using (org_id = current_org_id());

drop policy if exists sale_items_read on sale_items;
create policy sale_items_read on sale_items for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_items.sale_id and s.org_id = current_org_id()));

drop policy if exists sync_runs_read on sync_runs;
create policy sync_runs_read on sync_runs for select to authenticated
  using (org_id = current_org_id());

-- ── Device upload policies ────────────────────────────────────────────────
-- Tills are not signed-in users: they upload with the anon key plus an
-- x-device-token header. The policy proves the token belongs to the device
-- named in the row, so an anon key alone cannot forge or overwrite sales.
create or replace function device_token_ok(p_device text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from devices d
    where d.id = p_device
      and d.token = coalesce(current_setting('request.headers', true)::json ->> 'x-device-token', '')
  )
$$;

drop policy if exists sales_device_insert on sales;
create policy sales_device_insert on sales for insert to anon
  with check (device_token_ok(device_id) and device_id is not null);

drop policy if exists sale_items_device_insert on sale_items;
create policy sale_items_device_insert on sale_items for insert to anon
  with check (exists (
    select 1 from sales s
    where s.id = sale_items.sale_id
      and device_token_ok(s.device_id)
  ));

drop policy if exists sync_runs_device_insert on sync_runs;
create policy sync_runs_device_insert on sync_runs for insert to anon
  with check (device_token_ok(device_id));

drop policy if exists devices_device_update on devices;
create policy devices_device_update on devices for update to anon
  using (device_token_ok(id))
  with check (device_token_ok(id));

-- ── Onboarding a shop (run once, as the project owner) ─────────────────────
-- 1. insert into orgs (name) values ('My Shop');
-- 2. create the owner's login in Authentication, then:
--      insert into profiles (id, org_id, email, role)
--      values ('<auth-user-id>', '<org-id>', '<email>', 'OWNER');
-- 3. register each till (token: any long random string, kept in the app):
--      insert into devices (id, org_id, branch_id, name, platform, token)
--      values ('<device-uuid>', '<org-id>', '<branch-id>', 'Counter 1', 'android', '<token>');
