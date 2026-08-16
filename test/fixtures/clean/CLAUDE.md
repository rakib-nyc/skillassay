# Ledger service

Non-standard conventions that are not discoverable from the code or tooling.

- Money is stored as integer minor units. There is no `Decimal` type in this codebase;
  a float in a monetary field is always a bug.
- Every write to `accounts` must go through `TransactionGuard`, which acquires the
  advisory lock our replica topology requires. Direct writes bypass it silently.
- Reconciliation jobs run against the read replica and may observe up to 90s of lag.
  Treat a missing row as "not yet replicated", not "absent".
