--liquibase formatted sql
--changeset test:deliberate-failure
CREATE TABLE wagering.failed_probe (id integer);
SELECT deliberate_missing_function();
--rollback DROP TABLE wagering.failed_probe;
