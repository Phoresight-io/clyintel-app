-- ============================================================================
-- TEST ONLY — clyintel-dev (mhvuqjryesjsrictesuk).
-- NEVER APPLY TO PROD (clyintel-prod, ftttyxknwwrlfsqxntxr).
-- The DO-block guard below aborts if the exact Test rows are not all present,
-- so it fails loudly anywhere else — but do not rely on that: do not run it on Prod.
-- ============================================================================
--
-- Fee-gate fix (locked rules, Charles 2026-09-30). One-off correction of the
-- emission-time booleans on Test's existing balance_events rows, which were
-- computed from invoices.reminder_count (never written) instead of real outreach.
-- Re-derived under the new rule (outreach_started_at before the payment):
--   inv 1036 (45916dc6…)  real email 2026-09-10, payment 2026-09-23 → true / true
--   inv 1007 (33b51ada…, 957daeeb…)  no real outreach (SIMULATION only) → false / false
--   inv 1010 (347a3c0c…), inv 1033 (6d480c02…)  already false → no change
-- rev_share_ledger is NOT touched (append-only).
--
-- Idempotent: rows already carrying evidence.correction are skipped.

-- 1. Confirm the 5 rows (read-only). Expected as of 2026-10-01:
--   33b51ada-9634-4ad3-98f6-349afc2b7170  1007  true  true
--   957daeeb-821c-4d58-9929-60d2f33ec09e  1007  true  true
--   6d480c02-762d-4603-ba68-2efbb79c31b7  1033  false false
--   45916dc6-ebe0-41c2-8811-c7d400bddd77  1036  false false
--   347a3c0c-dd21-4fb1-860f-77955c13e912  1010  false false
select b.id, i.invoice_number, b.outreach_had_fired, b.fee_eligible, b.detected_at, b.evidence
  from public.balance_events b
  join public.invoices i on i.id = b.invoice_id
 order by b.detected_at;

-- 2. Guard: abort unless all three target rows exist (they exist only on Test).
do $$
begin
  if (select count(*) from public.balance_events
       where id in ('45916dc6-ebe0-41c2-8811-c7d400bddd77',
                    '33b51ada-9634-4ad3-98f6-349afc2b7170',
                    '957daeeb-821c-4d58-9929-60d2f33ec09e')) <> 3 then
    raise exception 'TEST-ONLY correction: target balance_events rows not found — wrong database? Aborting.';
  end if;
end $$;

-- 3. Correct by explicit id. SET expressions read the PRE-update row, so
--    prior_* capture the old values.
update public.balance_events b
   set outreach_had_fired = v.outreach_had_fired,
       fee_eligible       = v.fee_eligible,
       evidence = coalesce(b.evidence, '{}'::jsonb) || jsonb_build_object(
         'correction', jsonb_build_object(
           'reason',                   'fee-gate fix 2026-09-30',
           'prior_fee_eligible',       b.fee_eligible,
           'prior_outreach_had_fired', b.outreach_had_fired,
           'corrected_by',             'fix/fee-gate-outreach-started-at (manual, Test only)',
           'corrected_at',             now()
         ))
  from (values
          ('45916dc6-ebe0-41c2-8811-c7d400bddd77'::uuid, true,  true),   -- inv 1036
          ('33b51ada-9634-4ad3-98f6-349afc2b7170'::uuid, false, false),  -- inv 1007
          ('957daeeb-821c-4d58-9929-60d2f33ec09e'::uuid, false, false)   -- inv 1007
       ) as v(id, outreach_had_fired, fee_eligible)
 where b.id = v.id
   and not (coalesce(b.evidence, '{}'::jsonb) ? 'correction');

-- 4. Read-back: re-run step 1; expect 1036 true/true, 1007 ×2 false/false with
--    evidence.correction set, 1010 and 1033 unchanged (false/false, no correction).
