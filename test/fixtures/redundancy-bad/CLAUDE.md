# Payments API

We use typescript and express in this project.

Write clean code.
Follow best practices.
Prefer single quotes.

## Project structure

- src/
  - routes/
  - services/

## Where the data lives

- `src/routes/` — HTTP handlers
- `warehouse/` — nightly export staging

## Skill layout

Every skill directory must follow this shape:

```
{skill-name}/
  SKILL.md          # Required
  scripts/          # Optional
```

## Non-obvious constraints

Refunds must be issued through `RefundGateway`; the raw Stripe client is rate-limited
to 3 requests per second by contract and will silently drop excess calls.
