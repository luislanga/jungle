# Operations and API behavior

## Persistence and migrations

Liquibase Community 5.0.4 runs in a one-shot container, with PostgreSQL JDBC 42.7.14. It reads `database/changelog/db.changelog.yaml`, which includes the numbered formatted SQL files in `changes/`. Each table and each database function with its triggers has its own migration and explicit rollback. TypeORM maps entities with `synchronize: false` and `migrationsRun: false`.

```sh
docker compose up -d postgres
bun run migration:up
bun run migration:status
# On a disposable database, undo the last changeset and reapply:
bun run migration:down
bun run migration:up
```

Rollback can remove tables and their data; stop writers and use a disposable database or a suitable backup. Never edit an applied SQL changeset to change schema: add another version. Liquibase records checksums/history in `public.databasechangelog` and uses `public.databasechangeloglock` for migration coordination. Repeated startup does not reapply completed changesets. Existing incompatible data/schema stops migration rather than silently resetting it.

PostgreSQL's image executes `docker/postgres/init-roles.sh` only when initializing an empty data directory. It creates separate runtime and migrator roles. Changing `.env` passwords later does not rotate existing database credentials; update roles deliberately and keep `DATABASE_URL` consistent. The application never connects as the administrator.

## Transaction boundary

TypeORM was chosen for familiar repositories and explicit transaction-scoped `EntityManager` support. Domain objects have no ORM/Nest decorators; mappers use `rehydrate` to restore persisted state without replaying a transition. Money uses a private decimal.js clone, immutable operations and exact `NUMERIC(20,2)` strings. PostgreSQL itself rounds excess decimal scale, so inputs reject it before insertion.

The shared wager use case handles HTTP, SQS and pending resume. Its lock order is business identity/transaction, optional Inbox, wallet `FOR NO KEY UPDATE`, then immutable reference inspection. All writes use the same transaction manager. PostgreSQL serializes writers to one wallet while allowing different wallets to progress. Retryable serialization/deadlock/lock-timeout failures restart the entire transaction with fresh state, up to three attempts.

The wallet, terminal wager/result balance, ledger, Inbox and integration events commit together. A positive wallet opening creates internal OPENING, CREDIT ledger and both events in that transaction; zero opening creates none. Wallet version starts at 1 and changes only when balance changes. LOSS and rejection produce no ledger.

Constraints, unique indexes, restricted permissions and triggers defend nonnegative amounts/balances, identities, arithmetic, context and immutable ledger/terminal outcomes. A row CHECK cannot compare wallet balance with another table's ledger sum: that equality depends on the coordinated write protocol. Reconciliation detects privileged or defective writes that bypass it; it never repairs them silently.

## HTTP contracts

| Route                                                                     | Result                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /wallets`                                                           | 201; duplicate player/currency is 409                                                    |
| `GET /wallets/:walletId`                                                  | Current wallet, 200                                                                      |
| `GET /wallets/:walletId/ledger?cursor=...&limit=50`                       | `{items,nextCursor}`, 200                                                                |
| `POST /wagering/transactions`                                             | 200 processed/replay; 202 pending; 422 business rejection                                |
| `GET /wagering/transactions/:transactionId`                               | Current durable transaction, 200                                                         |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Same lookup by provider identity, 200                                                    |
| `POST /wallets/:walletId/reconciliation`                                  | 200 with exact stored/calculated balance, signed difference, consistency and entry count |
| `GET /health/live`                                                        | 200, process only                                                                        |
| `GET /health/ready`                                                       | 200 or 503, PostgreSQL and all required SQS queues                                       |
| `GET /metrics`                                                            | Prometheus text, 200; dependency collection failure exposed as a metric                  |

Malformed input is 400; missing resources are 404; conflicting keys, provider identities or wallet identity are 409; temporary database/lock exhaustion is 503. Unexpected errors are 500. A stored FAILED result also returns 500. Error envelopes contain `code`, `message` and `correlationId`, without SQL or stack traces. Business results carry `failureCode` rather than requiring message parsing.

The supplied idempotency key is authoritative and globally unique. The caller should namespace it, for example `provider-a:transaction-123`. Same key and normalized payload returns the original outcome/balance with `idempotentReplay: true`, even after later movements. Same key/different payload conflicts. Same provider/external ID with another key also conflicts, including an otherwise identical request. Pending replay returns the durable pending result until a resolver terminalizes that original transaction.

Ledger cursors are opaque, versioned, wallet-bound base64url values with the last `(createdAt,id)`. SQL preserves timestamp microseconds, orders ascending, and limits pages to 1–200 (default 50). Traversal is stable for existing entries; it is not a historical snapshot that excludes later appends.

## Canonical payload hash

Both adapters normalize money to two places, validate uppercase BRL and hash the business object with SHA-256 over UTF-8 JSON. Object keys are recursively sorted; arrays retain order; absent optional reference is omitted. Unknown fields and explicit null references are rejected. Included fields: providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money.amount, money.currency and optional referenceExternalTransactionId. The key, envelope messageId/type/occurredAt and HTTP metadata are excluded.

Independent vector: `{"a":"0","b":{"x":"1","y":"2"}}` hashes to `0f42989a92c60ac42e3f5baf2eb05f817980bba2064c8441e5b4724686aeace3`. Reversing object key order gives the same digest. `test/unit/canonical-hash.spec.ts` verifies this and business-field/transport normalization cases.

## Business interpretations

- README specifies reversal uniqueness per reference **and kind**. Consequently one BET can receive one REFUND and one ROLLBACK if each satisfies its rules. This can create a second credit; for production we would clarify that economic behavior before implementing it. This challenge follows the literal rule, with comments beside domain validation and the partial unique index.
- WIN accepts two payload shapes: without a reference it credits immediately; with a valid processed BET reference it also processes immediately. A supplied absent/pending reference waits; an invalid terminal reference rejects. A different game ID is allowed when the required provider/player/wallet/currency/round context matches.
- Zero handling is an interpretation of unspecified behavior: initial zero and zero LOSS are allowed; BET/WIN/REFUND/ROLLBACK must be positive. Negative inputs are invalid. Internal Money arithmetic and reconciliation differences can be signed.
- PENDING can become PENDING_REFERENCE, PROCESSED, REJECTED or FAILED. PENDING_REFERENCE can remain pending during reevaluation or become terminal. PROCESSED/REJECTED/FAILED cannot transition or lose their original result. An infrastructure outage does not itself justify FAILED; there is no routine request that manufactures permanent infrastructure failure. Malformed messages go to DLQ, not a fabricated wager.

| Business failure              | Meaning                                             |
| ----------------------------- | --------------------------------------------------- |
| `INSUFFICIENT_FUNDS`          | BET cannot debit the wallet                         |
| `REVERSAL_INSUFFICIENT_FUNDS` | Inverse credit reversal would make balance negative |
| `MONEY_OVERFLOW`              | Movement exceeds exact stored precision bounds      |
| `REFERENCE_CONTEXT_MISMATCH`  | Provider/player/wallet/currency/round mismatch      |
| `INVALID_REFERENCE_KIND`      | REFUND/ROLLBACK/WIN references an ineligible kind   |
| `REFERENCE_AMOUNT_MISMATCH`   | Partial reversal requested                          |
| `REFERENCE_ALREADY_REVERSED`  | This kind already reversed the reference            |
| `REFERENCE_NOT_PROCESSED`     | Referenced terminal operation did not succeed       |
| `REFERENCE_NOT_FOUND_EXPIRED` | Pending reference reached its attempt/age ceiling   |

`src/shared/errors/errors.constant.ts` and `src/shared/enums/wager.enum.ts` hold the complete machine-code definitions. Illegal terminal transitions are programming errors. Currency mismatches and invalid creation inputs are rejected before accepting a valid wager.

## Queues, leases and recovery

`wager-transactions.fifo` receives the README's `WagerTransactionRequested` envelope. Inbox identity is `(consumerName, envelope.messageId)`, independent of the SQS MessageId and business key. Duplicate envelopes and HTTP/SQS duplicates use persisted SQL identities. DeleteMessage occurs only after financial commit, including a durable pending/rejected outcome.

`wager-transactions-dlq.fifo` retains messages for 14 days. The source redrive policy allows five receives; transient/permanent delivery failures remain unacknowledged and use bounded visibility backoff. Committed business rejection is acknowledged. To redrive after correcting an outage or poison input, send the original envelope/key to the source with a fresh transport deduplication ID, then delete the DLQ record only after SendMessage succeeds. Receiving a DLQ message is a delivery operation; use GetQueueAttributes for observation.

`wager-events.fifo` is the additional integration queue. Events are `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` and `WagerTransactionPendingReference`, each version 1. Their envelope contains stable eventId, aggregateId, correlationId, optional causationId, occurredAt ISO timestamp and JSON data with decimal strings. OPENING and LOSS emit processed events; only balance changes emit balance events. Entering pending emits one pending event, not another on every retry.

Publishers commit short `FOR UPDATE SKIP LOCKED` claims, send without SQL locks, then mark success using an unexpired token. A crashed publisher leaves an expiring claim. A crash after send/before mark can publish again with the same eventId: downstream effects must persistently deduplicate that ID in their own effect transaction. FIFO deduplication is only an optimization. Test sinks demonstrate distinct transport duplicates without waiting for the short FIFO deduplication window.

Pending resolvers claim due work with the same expiring/fenced pattern, then explicitly resume the original wager through the shared financial use case. Missing references back off; reaching either TTL or attempt cap produces one REJECTED result/event. A valid reference arriving later does not reopen a terminal rejection.

| Configurable demo setting                           | Default                                                    |
| --------------------------------------------------- | ---------------------------------------------------------- |
| Database lock / transaction timeout                 | 2s / 5s                                                    |
| Whole-transaction attempts / jitter cap             | 3 / 250ms (25ms base)                                      |
| SQS long poll / visibility / heartbeat              | 10s / 30s / 10s                                            |
| In-flight messages / processing window per instance | 4 / 20s                                                    |
| Inbound retry visibility                            | 1s → 30s, five receives                                    |
| Pending TTL / evaluations                           | 5 minutes / 10; either ceiling rejects                     |
| Pending retry delay / poll / lease                  | 1,2,4,8,16,30s then 30s / 1s / 30s                         |
| Outbox poll / batch / lease                         | 1s / 20 / 30s                                              |
| Outbox retry / escalation                           | 1s → 60s with jitter / after 10 attempts; retain and retry |
| Shutdown drain / Compose grace                      | 20s / 30s                                                  |

All application settings are listed in `.env.example`; queue redrive/retention settings live in `docker/localstack/`. Five minutes and ten evaluations are demo choices, not production recommendations. Provider delays/SLA and recovery windows need review. Illustrative discussion settings could be 24 hours/20 evaluations with a 2-hour cap, or 72 hours/40 evaluations with a 4-hour cap; these are not measured guarantees. Attempt and age ceilings are independent, so review the full schedule.

On SIGTERM workers stop receiving, drain active work, and close dependencies. At the drain deadline they attempt to return receipt visibility and exit; uncommitted SQL rolls back when the connection closes. After an uncertain commit, replay uses stored results. Cancelled long polls can leave already received work invisible until the receipt window expires, so recovery need not be immediate.

Do not clear Inbox, financial history or idempotency rows to force a retry. For an unpublished Outbox backlog, restore SQS and allow due retries/expired claims to recover. Events are retained beyond escalation; investigate errors instead of deleting them. Reconciliation reports/logs/counts discrepancies and does not silently mutate balance or ledger.

## Observability and limits

Logs are JSON with applicable correlation/message/transaction/wallet/provider IDs and an allowlisted scalar context. They omit full payloads, money data, tokens, credentials and raw database errors. An incoming `x-correlation-id` is propagated or a fresh ID is assigned.

Metrics cover committed outcomes by status, successful duplicate replays, retry source, lock conflicts, processing latency, actual DLQ depth, oldest unpublished Outbox age, discrepancies and dependency collection failures. Counters/latencies are process-local; aggregate rates with restart-aware counters. Shared backlog gauges should use the maximum across replicas, not sum. Metrics are operational signals, not the durable financial audit; a crash between commit and counter increment can leave a count gap.

Readiness checks PostgreSQL under the runtime role and all three queue resources, with a one-second response budget per dependency. Liveness performs no dependency calls. Metrics collection failure preserves the last observation and exposes dependency failure rather than preventing all metrics from being scraped.

LocalStack 4.9.2 has an observed FIFO receipt validation limitation: extensions can keep a message invisible yet DeleteMessage rejects a receipt whose total age exceeds its latest visibility duration. Defaults keep normal processing below 30 seconds. The slow-heartbeat fixture accounts for this emulator limitation; it does not modify the emulator or claim production SQS has that behavior. LocalStack queues are not persisted by this Compose configuration. Temporary pause/unpause tests preserve queues; container recreation can lose queued input. PostgreSQL uses a named volume.

Authentication is omitted as permitted by the challenge. `ChallengeAuthGuard` is deliberately a no-op. A production integration would verify external OIDC tokens, bind provider identity/permissions to the caller, and authorize access to the requested provider/player/wallet. There is no custom password store. SQS is a trusted internal channel, with the same domain context validation.

No dashboard, double-entry accounting, load benchmark or production deployment is included. Optional work was deferred in favor of financial correctness and real concurrency/crash tests.
