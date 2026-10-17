--liquibase formatted sql

--changeset jungle:008-protect-financial-audit splitStatements:false
--comment: Prevent edits to ledger history and deletion of wager history.
CREATE FUNCTION wagering.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Financial audit records cannot be changed or removed' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON wagering.wallet_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION wagering.reject_audit_mutation();
CREATE TRIGGER wager_no_delete BEFORE DELETE OR TRUNCATE ON wagering.wager_transactions FOR EACH STATEMENT EXECUTE FUNCTION wagering.reject_audit_mutation();

--rollback DROP TRIGGER wager_no_delete ON wagering.wager_transactions;
--rollback DROP TRIGGER ledger_immutable ON wagering.wallet_ledger_entries;
--rollback DROP FUNCTION wagering.reject_audit_mutation();
