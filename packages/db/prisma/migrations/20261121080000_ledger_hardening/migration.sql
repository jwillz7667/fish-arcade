-- Database guards for invariants postJournal relies on (review R1, M1; spec §10.2). The app
-- already enforces each of these; the database now refuses violations from any code path.

-- 1. Zero-sum per currency, checked at commit. The earlier check summed across currencies, so
-- a GC +5 / SC -5 journal passed.
CREATE OR REPLACE FUNCTION "reef_assert_journal_balanced"(p_journal_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_count bigint;
  v_unbalanced text;
BEGIN
  SELECT count(*) INTO v_count FROM "ledger_entries" WHERE "journal_id" = p_journal_id;
  SELECT string_agg(per_currency."currency"::text || '=' || per_currency."total"::text, ', '
                    ORDER BY per_currency."currency")
    INTO v_unbalanced
    FROM (SELECT a."currency", sum(e."amount") AS "total"
            FROM "ledger_entries" e
            JOIN "ledger_accounts" a ON a."id" = e."account_id"
           WHERE e."journal_id" = p_journal_id
           GROUP BY a."currency") AS per_currency
   WHERE per_currency."total" <> 0;
  IF v_count < 2 OR v_unbalanced IS NOT NULL THEN
    RAISE EXCEPTION 'journal % is unbalanced: % entries, non-zero sums: %',
      p_journal_id, v_count, coalesce(v_unbalanced, 'none')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_balanced';
  END IF;
END;
$$;

-- 2. Ledger accounts never change once created. Relabelling an account's owner_type would
-- cascade into balances and lift the non-negative check on player money.
CREATE TRIGGER "ledger_accounts_immutable" BEFORE UPDATE OR DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION "reef_reject_mutation"();
CREATE TRIGGER "ledger_accounts_no_truncate" BEFORE TRUNCATE ON "ledger_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION "reef_reject_mutation"();
REVOKE UPDATE, DELETE, TRUNCATE ON "ledger_accounts" FROM reef_app;

-- 3. Balance rows are never deleted: a deleted row would silently restart at zero on the next
-- journal. postJournal still updates them.
CREATE TRIGGER "balances_no_delete" BEFORE DELETE ON "balances"
  FOR EACH ROW EXECUTE FUNCTION "reef_reject_mutation"();
CREATE TRIGGER "balances_no_truncate" BEFORE TRUNCATE ON "balances"
  FOR EACH STATEMENT EXECUTE FUNCTION "reef_reject_mutation"();
REVOKE DELETE, TRUNCATE ON "balances" FROM reef_app;

-- 4. The composite key that pins balances.owner_type no longer cascades updates.
ALTER TABLE "balances" DROP CONSTRAINT "balances_account_id_owner_type_fkey";
ALTER TABLE "balances" ADD CONSTRAINT "balances_account_id_owner_type_fkey"
  FOREIGN KEY ("account_id", "owner_type") REFERENCES "ledger_accounts"("id", "owner_type")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
