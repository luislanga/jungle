--liquibase formatted sql

--changeset jungle:007-protect-ledger-insert splitStatements:false
--comment: Require ledger entries to match their processed financial transaction.
CREATE FUNCTION wagering.protect_ledger_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tx wagering.wager_transactions%ROWTYPE; ref_kind text; expected_direction text;
BEGIN
    SELECT * INTO tx FROM wagering.wager_transactions WHERE id = NEW.transaction_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transaction does not exist' USING ERRCODE = '23503'; END IF;
    IF tx.status <> 'PROCESSED' OR tx.kind = 'LOSS' OR tx.amount <> NEW.amount THEN
        RAISE EXCEPTION 'Ledger must match a processed financial transaction' USING ERRCODE = '23514';
    END IF;
    expected_direction := CASE WHEN tx.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
    IF tx.kind = 'ROLLBACK' THEN
        SELECT kind INTO ref_kind FROM wagering.wager_transactions WHERE id = tx.reference_transaction_id;
        expected_direction := CASE WHEN ref_kind = 'BET' THEN 'CREDIT' ELSE 'DEBIT' END;
    END IF;
    IF NEW.direction <> expected_direction THEN RAISE EXCEPTION 'Ledger direction differs from operation' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER ledger_insert_guard BEFORE INSERT ON wagering.wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION wagering.protect_ledger_insert();

--rollback DROP TRIGGER ledger_insert_guard ON wagering.wallet_ledger_entries;
--rollback DROP FUNCTION wagering.protect_ledger_insert();
