--liquibase formatted sql

--changeset jungle:001-initialize-schema
--comment: Create the application schema.
CREATE SCHEMA wagering AUTHORIZATION wager_migrator;
GRANT USAGE ON SCHEMA wagering TO wager_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA wagering
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wager_app;

-- These permissions apply to tables created later by wager_migrator.
-- When we add the ledger, we must remove its UPDATE and DELETE permissions
-- and prevent changes to existing entries in the database.
--
-- A CHECK constraint cannot compare a wallet's balance with rows in the ledger.
-- We must update both in the same transaction to keep them consistent (business rule enforcement).

--rollback ALTER DEFAULT PRIVILEGES IN SCHEMA wagering REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM wager_app;
--rollback DROP SCHEMA wagering;
