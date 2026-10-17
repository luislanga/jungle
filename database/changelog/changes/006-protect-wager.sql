--liquibase formatted sql

--changeset jungle:006-protect-wager splitStatements:false
--comment: Protect wager payloads and terminal outcomes, and validate resolved references.
CREATE FUNCTION wagering.protect_wager() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref wagering.wager_transactions%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
            RAISE EXCEPTION 'Terminal transactions are immutable' USING ERRCODE = '23514';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id, OLD.created_at) THEN
            RAISE EXCEPTION 'Business payload is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
            RAISE EXCEPTION 'Pending reference cannot return to pending' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.reference_transaction_id IS NOT NULL THEN
        SELECT * INTO ref FROM wagering.wager_transactions WHERE id = NEW.reference_transaction_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Reference does not exist' USING ERRCODE = '23503'; END IF;
        IF (ref.provider_id, ref.external_transaction_id, ref.player_id, ref.wallet_id, ref.currency, ref.round_id)
            IS DISTINCT FROM (NEW.provider_id, NEW.reference_external_transaction_id, NEW.player_id, NEW.wallet_id, NEW.currency, NEW.round_id) THEN
            RAISE EXCEPTION 'Reference context differs' USING ERRCODE = '23514';
        END IF;
        IF NEW.status = 'PROCESSED' THEN
            IF ref.status <> 'PROCESSED' OR
                (NEW.kind IN ('WIN','REFUND') AND ref.kind <> 'BET') OR
                (NEW.kind = 'ROLLBACK' AND ref.kind NOT IN ('BET','WIN','REFUND')) THEN
                RAISE EXCEPTION 'Reference is not eligible' USING ERRCODE = '23514';
            END IF;
            IF NEW.kind IN ('REFUND','ROLLBACK') AND NEW.amount <> ref.amount THEN
                RAISE EXCEPTION 'Partial reversals are not allowed' USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER wager_write_guard BEFORE INSERT OR UPDATE ON wagering.wager_transactions FOR EACH ROW EXECUTE FUNCTION wagering.protect_wager();

--rollback DROP TRIGGER wager_write_guard ON wagering.wager_transactions;
--rollback DROP FUNCTION wagering.protect_wager();
