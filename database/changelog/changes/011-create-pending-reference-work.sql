--liquibase formatted sql

--changeset jungle:011-create-pending-reference-work
-- Keep scheduling and leases separate from the wager's immutable business data.
CREATE TABLE wagering.pending_reference_work (
    transaction_id  uuid        PRIMARY KEY REFERENCES wagering.wager_transactions(id),
    attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL,
    expires_at      timestamptz NOT NULL,
    claim_owner     text,
    claim_token     uuid,
    claim_until     timestamptz,
    CHECK ((claim_owner IS NULL AND claim_token IS NULL AND claim_until IS NULL)
        OR (claim_owner IS NOT NULL AND claim_owner <> '' AND claim_token IS NOT NULL AND claim_until IS NOT NULL))
);
CREATE INDEX pending_reference_due ON wagering.pending_reference_work(next_attempt_at, transaction_id);

--rollback DROP TABLE wagering.pending_reference_work;
