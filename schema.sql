-- DeryAccount Admin — Supabase schema
-- Mirrors exactly what the Android/desktop sync engine already pushes, so the
-- apps need no change to be visible here. Column names are quoted camelCase to
-- match the JSON keys the apps send.

create extension if not exists "pgcrypto";

-- ---------- tenancy ----------
create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  email text,
  role text not null default 'OWNER',
  created_at timestamptz not null default now()
);

create table if not exists branches (
  id text primary key,
  "orgId" uuid references orgs(id) on delete cascade,
  name text,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "isDeleted" boolean default false
);

create table if not exists sales (
  id text primary key,
  "orgId" uuid references orgs(id) on delete cascade,
  "branchId" text,
  "userId" text,
  "customerId" text,
  "receiptNo" text,
  "saleType" text,
  subtotal numeric(14,2) default 0,
  "taxTotal" numeric(14,2) default 0,
  discount numeric(14,2) default 0,
  total numeric(14,2) default 0,
  "amountPaid" numeric(14,2) default 0,
  "changeGiven" numeric(14,2) default 0,
  "paymentMethod" text,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "isDeleted" boolean default false,
  "platform" text default 'android',
  "deviceName" text,
  "syncedAt" timestamptz not null default now()
);
create index if not exists sales_org_created on sales ("orgId", "createdAt" desc);
create index if not exists sales_branch_created on sales ("branchId", "createdAt" desc);

create table if not exists sale_items (
  id text primary key,
  "saleId" text references sales(id) on delete cascade,
  "productId" text,
  "productName" text,
  qty numeric(14,3) default 0,
  "unitPrice" numeric(14,2) default 0,
  "lineTotal" numeric(14,2) default 0
);
create index if not exists sale_items_sale on sale_items ("saleId");

-- ---------- row level security ----------
alter table orgs enable row level security;
alter table profiles enable row level security;
alter table branches enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;

create or replace function current_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from profiles where id = auth.uid()
$$;

drop policy if exists org_read on orgs;
create policy org_read on orgs for select using (id = current_org_id());

drop policy if exists profile_read on profiles;
create policy profile_read on profiles for select using (org_id = current_org_id());

drop policy if exists branch_read on branches;
create policy branch_read on branches for select using ("orgId" = current_org_id());

drop policy if exists sales_read on sales;
create policy sales_read on sales for select using ("orgId" = current_org_id());

drop policy if exists sale_items_read on sale_items;
create policy sale_items_read on sale_items for select using (
  exists (select 1 from sales s where s.id = sale_items."saleId" and s."orgId" = current_org_id())
);

-- ---------- reporting ----------
create or replace view daily_sales as
select "orgId", "branchId", date_trunc('day', "createdAt")::date as day,
       count(*) as tickets,
       sum(total) as gross,
       sum("taxTotal") as vat,
       sum(discount) as discounts
from sales
where coalesce("isDeleted", false) = false
group by 1,2,3;
