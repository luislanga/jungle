--liquibase formatted sql

--changeset jungle:003-create-wager-transactions
--comment: Create wagers with idempotency, reference and terminal outcome constraints.
CREATE TABLE wagering.wager_transactions (
    id                                uuid          PRIMARY KEY,
    provider_id                       text          NOT NULL CHECK (provider_id <> ''),
    external_transaction_id           text          NOT NULL CHECK (external_transaction_id <> ''),
    idempotency_key                   text          NOT NULL UNIQUE CHECK (idempotency_key <> ''),
    payload_hash                      varchar(64)   NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    wallet_id                         uuid          NOT NULL,
    player_id                         uuid          NOT NULL,
    round_id                          text          NOT NULL CHECK (round_id <> ''),
    game_id                           text          NOT NULL CHECK (game_id <> ''),
    kind                              text          NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
    amount                            numeric(20,2) NOT NULL CHECK (amount >= 0 AND amount <= 999999999999999999.99 AND (kind = 'LOSS' OR amount > 0)),
    currency                          varchar(3)    NOT NULL,
    status                            text          NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
    reference_external_transaction_id text,
    reference_transaction_id          uuid          REFERENCES wagering.wager_transactions(id),
    failure_code                      text,
    result_balance                    numeric(20,2) CHECK (result_balance >= 0 AND result_balance <= 999999999999999999.99),
    created_at                        timestamptz   NOT NULL DEFAULT now(),
    processed_at                      timestamptz,
    FOREIGN KEY (wallet_id, player_id, currency) REFERENCES wagering.wallets(id, player_id, currency),
    UNIQUE (id, wallet_id, currency),
    CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
    CHECK (reference_external_transaction_id IS NULL OR (reference_external_transaction_id <> '' AND reference_external_transaction_id <> external_transaction_id)),
    CHECK (reference_transaction_id IS NULL OR (reference_external_transaction_id IS NOT NULL AND reference_transaction_id <> id)),
    CHECK (status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL),
    CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
    CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
    CHECK (failure_code IS NULL OR failure_code <> ''),
    CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR result_balance IS NOT NULL)
);

CREATE UNIQUE INDEX wager_external_identity ON wagering.wager_transactions(provider_id, external_transaction_id) WHERE kind <> 'OPENING';
CREATE UNIQUE INDEX wager_opening_wallet ON wagering.wager_transactions(wallet_id) WHERE kind = 'OPENING';
-- README 7, additional rule 4 makes reversals unique per kind. For this challenge we allow
-- one REFUND and one ROLLBACK on the SAME reference. In production we would first
-- discuss the possible double credit with product team.
CREATE UNIQUE INDEX wager_processed_reversal ON wagering.wager_transactions(reference_transaction_id, kind)
    WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE INDEX wager_wallet_history ON wagering.wager_transactions(wallet_id, created_at, id);
REVOKE DELETE, TRUNCATE ON wagering.wager_transactions FROM wager_app;

--rollback DROP TABLE wagering.wager_transactions;
