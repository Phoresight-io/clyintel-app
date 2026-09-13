-- Migration: create_persist_fee_settlement_rpc
-- Applied to clyintel-dev (mhvuqjryesjsrictesuk) via Supabase MCP, 2026-09-13.
--
-- Monthly Settlement Sweep — ATOMIC persist. Prompt 2's persistSettlements did
-- the settlement insert and the line inserts as two separate supabase-js calls
-- (no cross-statement transaction), leaving a narrow "settlement created, crash
-- before lines" window. This RPC does both in ONE transaction (a plpgsql
-- function body is one transaction), so a settlement can never land without its
-- lines. It honors the same two unique guards with ON CONFLICT DO NOTHING, so a
-- repeat run neither duplicates a settlement nor double-links a ledger row.
--
-- Posture: SECURITY INVOKER (default) — the function runs as the caller, so only
-- the service_role (BYPASSRLS) can actually write; an anon/authenticated caller
-- is still blocked by the tables' deny-all/SELECT-only RLS. EXECUTE is revoked
-- from public/anon/authenticated and granted only to service_role. search_path
-- is pinned to '' (house convention; all refs fully-qualified).
--
-- p_lines is a JSON array of { ledger_row_id: uuid, fee_cents: bigint }. Returns
-- the settlement id and whether THIS call created it (false = already existed).
-- Additive + replay-safe (create or replace).

create or replace function public.persist_fee_settlement(
  p_subscriber_id uuid,
  p_cycle_close date,
  p_total_fee_cents bigint,
  p_currency text,
  p_line_count int,
  p_stripe_idempotency_key text,
  p_lines jsonb
)
returns table (settlement_id uuid, created boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.fee_settlements
    (subscriber_id, cycle_close, total_fee_cents, currency, status, line_count, stripe_idempotency_key)
  values
    (p_subscriber_id, p_cycle_close, p_total_fee_cents, coalesce(p_currency, 'USD'),
     'pending', p_line_count, p_stripe_idempotency_key)
  on conflict (subscriber_id, cycle_close) do nothing
  returning id into v_id;

  if v_id is not null then
    -- Newly created: link its ledger rows in the SAME transaction.
    insert into public.fee_settlement_lines (settlement_id, ledger_row_id, fee_cents)
    select v_id, (elem->>'ledger_row_id')::uuid, (elem->>'fee_cents')::bigint
    from jsonb_array_elements(p_lines) as elem
    on conflict (ledger_row_id) do nothing;

    return query select v_id, true;
  else
    -- Already existed (idempotent re-run): return its id, do not touch its lines.
    select fs.id into v_id
    from public.fee_settlements fs
    where fs.subscriber_id = p_subscriber_id and fs.cycle_close = p_cycle_close;

    return query select v_id, false;
  end if;
end;
$$;

revoke all on function public.persist_fee_settlement(uuid, date, bigint, text, int, text, jsonb) from public, anon, authenticated;
grant execute on function public.persist_fee_settlement(uuid, date, bigint, text, int, text, jsonb) to service_role;
