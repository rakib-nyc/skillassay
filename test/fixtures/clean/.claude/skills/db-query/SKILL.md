---
name: ledger-db-query
description: Builds parameterised SQL against the ledger schema. Use when the user asks to read from or write to the accounts, postings, or journals tables.
---

# Ledger queries

Compose statements with `db.from()`. Never interpolate values into SQL strings.
