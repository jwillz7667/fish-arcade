-- Ledger and audit invariants that Prisma cannot express. Spec §10.2, §15; playbook Step 3.

-- Every ledger entry moves money.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("amount" <> 0);

-- Global accounts (house, redemption pipeline) have no owner; every other account has one.
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_matches_type"
  CHECK (("owner_type" IN ('house', 'redemption')) = ("owner_id" IS NULL));

-- Player money, held directly or in table session escrow, can never go negative. House,
-- jackpot, and redemption accounts may go negative as the source side of journals.
-- balances.owner_type is pinned to the account's real owner_type by a composite foreign key.
ALTER TABLE "balances" ADD CONSTRAINT "balances_player_owned_non_negative"
  CHECK ("owner_type" NOT IN ('player', 'session') OR "amount" >= 0);

-- Spec §10.2: a journal has two or more entries that sum to zero. Checked at commit, so a
-- journal and its entries can be inserted in any order within one transaction.
CREATE FUNCTION "reef_assert_journal_balanced"(p_journal_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_count bigint;
  v_sum numeric;
BEGIN
  SELECT count(*), coalesce(sum("amount"), 0)
    INTO v_count, v_sum
    FROM "ledger_entries"
   WHERE "journal_id" = p_journal_id;
  IF v_count < 2 OR v_sum <> 0 THEN
    RAISE EXCEPTION 'journal % is unbalanced: % entries summing to %', p_journal_id, v_count, v_sum
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_balanced';
  END IF;
END;
$$;

CREATE FUNCTION "reef_journals_balanced_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "reef_assert_journal_balanced"(NEW."id");
  RETURN NULL;
END;
$$;

CREATE FUNCTION "reef_ledger_entries_balanced_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "reef_assert_journal_balanced"(NEW."journal_id");
  RETURN NULL;
END;
$$;

-- Catches journals inserted with too few entries.
CREATE CONSTRAINT TRIGGER "journals_balanced"
  AFTER INSERT ON "journals"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "reef_journals_balanced_trigger"();

-- Catches entries added to a journal that already existed.
CREATE CONSTRAINT TRIGGER "ledger_entries_balanced"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "reef_ledger_entries_balanced_trigger"();

-- Append-only tables. Triggers fire for every role, including the owner, so history cannot be
-- rewritten even by a migration without first dropping the trigger in review.
CREATE FUNCTION "reef_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "journals_append_only" BEFORE UPDATE OR DELETE ON "journals"
  FOR EACH ROW EXECUTE FUNCTION "reef_reject_mutation"();
CREATE TRIGGER "journals_no_truncate" BEFORE TRUNCATE ON "journals"
  FOR EACH STATEMENT EXECUTE FUNCTION "reef_reject_mutation"();

CREATE TRIGGER "ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "reef_reject_mutation"();
CREATE TRIGGER "ledger_entries_no_truncate" BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "reef_reject_mutation"();

CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "reef_reject_mutation"();
CREATE TRIGGER "audit_logs_no_truncate" BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "reef_reject_mutation"();
