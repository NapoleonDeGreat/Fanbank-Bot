/*
# FanBank Users Table

## Purpose
Persists WhatsApp bot user state across server restarts. Each row represents
one unique WhatsApp number. The bot reads/writes this table instead of the
in-memory `users` object so data survives deploys.

## New Tables
- `fanbank_users`
  - `phone` (text, primary key) — WhatsApp phone number, e.g. "2348012345678"
  - `name` (text) — resolved from BVN/NIN or entered manually
  - `club` (text) — chosen club name, e.g. "Arsenal"
  - `club_data` (jsonb) — full club object {name, emoji, colors, rival}
  - `balance` (numeric) — wallet balance in NGN
  - `fansave` (numeric) — FanSave pot balance in NGN
  - `xp` (integer) — experience points
  - `streak` (integer) — daily streak count
  - `rank` (text) — rank label e.g. "Bronze Banter"
  - `pin` (text) — 4-digit banter PIN (stored as plain text; hash in future)
  - `state` (text) — current conversation state machine state
  - `pending_transfer` (jsonb) — in-flight transfer details {amount, accountNumber, bankName}
  - `anchor_customer_id` (text) — Anchor IndividualCustomer ID
  - `anchor_account_id` (text) — Anchor virtual DepositAccount ID
  - `account_number` (text) — virtual account number shown to user
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

## Security
- RLS enabled. Single-tenant public policies (no Supabase Auth) so the
  service-role key used by the Node server can read/write freely.
*/

CREATE TABLE IF NOT EXISTS fanbank_users (
  phone              text PRIMARY KEY,
  name               text,
  club               text,
  club_data          jsonb,
  balance            numeric NOT NULL DEFAULT 0,
  fansave            numeric NOT NULL DEFAULT 0,
  xp                 integer NOT NULL DEFAULT 0,
  streak             integer NOT NULL DEFAULT 0,
  rank               text NOT NULL DEFAULT 'Bronze Banter',
  pin                text,
  state              text,
  pending_transfer   jsonb,
  anchor_customer_id text,
  anchor_account_id  text,
  account_number     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fanbank_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_select" ON fanbank_users;
CREATE POLICY "service_select" ON fanbank_users FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "service_insert" ON fanbank_users;
CREATE POLICY "service_insert" ON fanbank_users FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "service_update" ON fanbank_users;
CREATE POLICY "service_update" ON fanbank_users FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_delete" ON fanbank_users;
CREATE POLICY "service_delete" ON fanbank_users FOR DELETE
  TO anon, authenticated USING (true);
