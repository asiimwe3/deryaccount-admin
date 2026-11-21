# DeryAccount Admin (web)

Owner-facing, **read-only** dashboard for DeryAccount. It shows the sales your
Android and Windows tills upload to Supabase. Selling, stock and the books stay
on the tills; nothing here can change a transaction.

Live: https://asiimwe3.github.io/deryaccount-admin/

## What it shows
- Owner sign-in (Supabase Auth email + password)
- Revenue, VAT, discounts and ticket counts for 1 / 7 / 30 / 90 days
- Daily sales chart, recent sales, branch filter, Android vs Desktop split
- Cashier names, per-device last-sync status
- CSV export of exactly the filtered rows

All day boundaries are **Africa/Kampala** (UTC+3): a sale at 00:30 belongs to
that Ugandan day, not the previous UTC day.

## Setup

1. Create a Supabase project.
2. SQL editor: run `supabase/schema.sql`.
3. Authentication → Users: create the owner's email + password.
4. Link the owner to a business:
   ```sql
   insert into orgs (name) values ('My Shop') returning id;
   insert into profiles (id, org_id, email, role)
   values ('<auth-user-id>', '<org-id>', '<email>', 'OWNER');
   ```
5. Register each till (token = any long random string you keep in the app):
   ```sql
   insert into devices (id, org_id, branch_id, name, platform, token)
   values ('<device-uuid>', '<org-id>', '<branch-id>', 'Counter 1', 'android', '<token>');
   ```
   The till's own id is shown in the app once you add it; or let the till
   register itself and read the id from the app's settings screen.
6. Project Settings → API: copy the URL and the **anon** key into `config.js`.
   Never the service_role key: this file is public.

## Security model
- RLS on every table; owners read only their own business (`current_org_id()`).
- No UPDATE or DELETE policy exists on `sales` or `sale_items`, so the dashboard
  cannot alter or remove a transaction.
- Tills upload with the anon key **plus** an `x-device-token` header. The insert
  policy proves the token belongs to the device named in the row, so a leaked
  anon key alone cannot inject or overwrite sales.
- Sales are keyed by the till's own UUID and uploaded with
  `Prefer: resolution=merge-duplicates`, so repeated or interrupted uploads
  cannot duplicate a sale.

## Hosting
Static, no build step. Any static host works (GitHub Pages is already wired).
