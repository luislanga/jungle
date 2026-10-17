--liquibase formatted sql

--changeset jungle:010-create-outbox-messages
CREATE TABLE wagering.outbox_messages (
    id              uuid        PRIMARY KEY,
    aggregate_id    uuid        NOT NULL REFERENCES wagering.wallets(id),
    event_type      text        NOT NULL CHECK (event_type <> ''),
    payload         jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    occurred_at     timestamptz NOT NULL,
    attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    claim_owner     text,
    claim_token     uuid,
    claim_until     timestamptz,
    CHECK (jsonb_exists_all(payload, ARRAY['eventId', 'aggregateId', 'eventType', 'version', 'occurredAt', 'data'])),
    CHECK ((payload->>'eventId') IS NOT NULL AND payload->>'eventId' = id::text),
    CHECK ((payload->>'aggregateId') IS NOT NULL AND payload->>'aggregateId' = aggregate_id::text),
    CHECK ((payload->>'eventType') IS NOT NULL AND payload->>'eventType' = event_type),
    CHECK ((claim_owner IS NULL AND claim_token IS NULL AND claim_until IS NULL)
        OR (claim_owner IS NOT NULL AND claim_owner <> '' AND claim_token IS NOT NULL AND claim_until IS NOT NULL)),
    CHECK (published_at IS NULL OR claim_token IS NULL)
);
CREATE INDEX outbox_due ON wagering.outbox_messages(next_attempt_at, id) WHERE published_at IS NULL;

--rollback DROP TABLE wagering.outbox_messages;
