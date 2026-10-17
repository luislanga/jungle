--liquibase formatted sql

--changeset jungle:005-protect-wallet splitStatements:false
--comment: Prevent wallet identity changes and require version changes to follow balance changes.
CREATE FUNCTION wagering.protect_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.version <> 1 THEN RAISE EXCEPTION 'Wallet version must start at one' USING ERRCODE = '23514'; END IF;
    ELSE
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
            RAISE EXCEPTION 'Wallet identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.version <> OLD.version + (CASE WHEN NEW.balance IS DISTINCT FROM OLD.balance THEN 1 ELSE 0 END) THEN
            RAISE EXCEPTION 'Wallet version must follow balance changes' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER wallet_write_guard BEFORE INSERT OR UPDATE ON wagering.wallets FOR EACH ROW EXECUTE FUNCTION wagering.protect_wallet();

--rollback DROP TRIGGER wallet_write_guard ON wagering.wallets;
--rollback DROP FUNCTION wagering.protect_wallet();
