# DeryAccount Admin (web)

Owner-facing web dashboard for DeryAccount. Read-only: it shows the sales your
Android and Windows tills push to Supabase. Selling stays on the devices.

## What it shows
- Owner sign-in (Supabase Auth, email + password)
- Today / 7 / 30 / 90 day totals, ticket counts, VAT collected
- Daily sales bar chart, recent sales table, branch filter, CSV export
- Phone vs desktop split, so you can see which till did the selling

## Setup (once)
1. Create a Supabase project.
2. SQL editor: run `schema.sql`. It creates the tables the apps already push to
   (`sales`, `sale_items`, `branches`, `products`, ...) plus row level security.
3. Create the owner's user in Authentication, then link it to a business:
   ```sql
   insert into orgs (name) values ('DeryCode');
   insert into profiles (id, org_id, email, role)
   values ('<auth user id>', (select id from orgs limit 1), '<email>', 'OWNER');
   ```
4. Project Settings -> API: copy the URL and the **anon** key into `config.js`.
   Never the service_role key: this file is public.

## Hosting
Any static host works (GitHub Pages, Vercel, Netlify). No build step.

## Device side
The apps push only when a shop enters the Supabase URL + anon key in Settings and
sync runs. Nothing about selling changes: offline tills keep working, they just
appear here after they next sync.
