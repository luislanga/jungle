--liquibase formatted sql

--changeset jungle:004-create-wallet-ledger-entries
--comment: Create ledger entries with exact arithmetic and links to their wallet and wager.
CREATE TABLE wagering.wallet_ledger_entries (
    id             uuid          PRIMARY KEY,
    wallet_id      uuid          NOT NULL,
    transaction_id uuid          NOT NULL,
    direction      text          NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
    amount         numeric(20,2) NOT NULL CHECK (amount > 0 AND amount <= 999999999999999999.99),
    currency       varchar(3)    NOT NULL,
    balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0 AND balance_before <= 999999999999999999.99),
    balance_after  numeric(20,2) NOT NULL CHECK (balance_after >= 0 AND balance_after <= 999999999999999999.99),
    created_at     timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (transaction_id, wallet_id),
    FOREIGN KEY (wallet_id, currency) REFERENCES wagering.wallets(id, currency),
    FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wagering.wager_transactions(id, wallet_id, currency),
    CHECK ((direction = 'CREDIT' AND balance_after = balance_before + amount)
        OR (direction = 'DEBIT' AND balance_after = balance_before - amount))
);
CREATE INDEX ledger_wallet_cursor ON wagering.wallet_ledger_entries(wallet_id, created_at, id);
REVOKE UPDATE, DELETE, TRUNCATE ON wagering.wallet_ledger_entries FROM wager_app;

-- These checks cannot tell whether a wallet's balance matches its ledger history.
-- The application must save the balance change, wager and ledger entry in one
-- database transaction: either all three are saved, or none are. Reconciliation
-- adds up the ledger entries and compares the total with the wallet balance.
-- PostgreSQL rounds extra decimal places before these checks run: 1.234 becomes
-- 1.23. The application must reject such input before saving it. The database
-- checks still reject negative balances, invalid numeric values and amounts above the limit.
-- This challenge uses BRL only; the Money class can also represent other currencies.

--rollback DROP TABLE wagering.wallet_ledger_entries;
