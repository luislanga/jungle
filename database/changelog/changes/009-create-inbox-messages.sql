--liquibase formatted sql

--changeset jungle:009-create-inbox-messages
-- The envelope ID belongs to the sender; SQS can assign a different transport ID on redelivery.
CREATE TABLE wagering.inbox_messages (
    consumer_name text        NOT NULL CHECK (consumer_name <> ''),
    message_id    text        NOT NULL CHECK (message_id <> ''),
    payload_hash  varchar(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    received_at   timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz,
    PRIMARY KEY (consumer_name, message_id)
);

--rollback DROP TABLE wagering.inbox_messages;
