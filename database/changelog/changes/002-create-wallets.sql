--liquibase formatted sql

--changeset jungle:002-create-wallets
--comment: Create wallets with unique ownership, exact balances and version checks.
CREATE TABLE wagering.wallets (
    id         uuid          PRIMARY KEY,
    player_id  uuid          NOT NULL,
    currency   varchar(3)    NOT NULL CHECK (currency = 'BRL'),
    balance    numeric(20,2) NOT NULL CHECK (balance >= 0 AND balance <= 999999999999999999.99),
    version    integer       NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz   NOT NULL DEFAULT now(),
    updated_at timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (player_id, currency),
    UNIQUE (id, player_id, currency),
    UNIQUE (id, currency)
);

--rollback DROP TABLE wagering.wallets;
