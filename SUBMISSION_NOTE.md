# Submission note

## What I pulled, and what I left out

The connector pulls five core Sage resources and normalizes them into Buki's four canonical finance types:
1. **Ledger Accounts** (`GET /ledger_accounts?attributes=all`): Charts of accounts mapped to canonical `LedgerAccount` (`asset`, `liability`, `equity`, `income`, `expense`). Passing `attributes=all` ensures `ledger_account_group` and nominal codes are read to accurately categorize assets (including bank and cash nominals `1200`-`1240`).
2. **Contacts** (`GET /contacts`): Customers and suppliers mapped to canonical `Party` with `kind: "customer" | "supplier" | "both"`. Fields absent from Sage (such as missing email addresses) are strictly omitted, never defaulted.
3. **Invoices** (`GET /sales_invoices?attributes=all`, `GET /purchase_invoices?attributes=all`): Trade receivables and payables mapped to canonical `Invoice`. Line items are mapped to canonical `InvoiceLine` with net amounts and ledger account references (`accountId`). Unpaid and part-paid invoices with due dates before today feed overdue receivables.
4. **Bank Movements** (`GET /other_payments`, `GET /contact_payments`, `GET /bank_transfers`): Actual bank movements mapped to canonical `BankTransaction`. General ledger invoice postings (`SALES_INVOICE`, `PURCHASE_INVOICE`) are excluded because invoice issuance is not a bank movement. Cash is strictly described and computed as the sum of supported imported bank movements (not a static statement balance). The bank account ID is mapped to the canonical nominal ledger account (`sage:<ledger_account.id>`), allowing the Finance module to display real bank names. If a transaction references an unmapped bank account, the normalizer throws an explicit Error rather than silently dropping it or fabricating a default ID.
5. **Business Settings & Base Currency** (`GET /financial_settings`): Authoritative base currency (`GBP`) is read from Sage. Hardcoded fallback strings were removed; if currency cannot be established, the normalizer throws an explicit error.

**What was left out and why:**
- **Sales & Purchase Credit Notes** (`/sales_credit_notes`, `/purchase_credit_notes`): Buki's canonical schema defines `Invoice` with positive totals and lines. Credit notes reduce accounts receivable or payable in Sage. Until allocated in Sage, an unallocated credit note leaves residual balances open on corresponding invoices (e.g., £0.05 on invoice `SI-69`). They are excluded from trade sales/purchase invoice figures to prevent sign corruption.
- **Contact Opening Balances** (`/contact_opening_balances`): Legacy opening balances represent balance sheet migration transfers from legacy accounting packages (e.g. Sage 50) rather than regular operational trade invoices. Because they are omitted from the trade invoice set, omitted opening balances may affect total customer debt calculations (AR/AP exposure) for migrated customers.
- **Manual Journals** (`/journals`): Nominal journal postings adjust general ledger accounts (such as accruals, prepayments, and depreciation) across debit/credit lines without trade invoice lines or customer/supplier bank movements. Because they are omitted from trade invoices and bank movements, omitted journals may affect ledger account balances on full nominal trial balance reports, but do not affect trade invoicing or transactional cash movement sums.

## How it stays in sync

- **Initial Sync**: A full sync pulls all ledger accounts, contacts, sales invoices, purchase invoices, and bank payments. The runner stores them atomically in `.data/store.json` using Buki's `runSync` engine.
- **Scheduled Sync (`npm run cron`)**: Runs on a loop every `SYNC_INTERVAL_SECONDS` (300 seconds default, or 5 seconds in fast test mode). The client queries list endpoints using `updated_or_created_since`, comparing returned entity timestamps (`updated_at`) against the local store.
- **Edit Detection**: When an invoice is edited in Sage (e.g., updating line items or references), the next scheduled run detects the updated timestamp, pulling only changed records (`pulled: 1, added: 0, changed: 1, removed: 0`) and updating the store within seconds.
- **Idempotence**: Running back-to-back syncs without source edits produces exactly zero additions, zero changes, and zero removals.

## When Sage is slow, down, or returns something unexpected

- **Timeouts & Slow Responses**: Every Sage API request is wrapped with an `AbortSignal.timeout(30_000)` (30 seconds). If Sage hangs, a typed `SageError("timeout")` is raised.
- **API Down or HTTP Errors**: Network disconnects, 5xx server errors, and 429 rate limits throw a typed `SageError("network" | "http")`.
- **Token Expiry**: Sage access tokens expire in 300 seconds. An internal mutex lock (`refreshPromise`) deduplicates concurrent refresh requests, preventing race conditions on single-use refresh tokens. If credentials or refresh tokens are invalid, a `SageError("auth")` is thrown.
- **Store Preservation**: `runSync` performs all domain pulls in memory before writing to disk. If any pull fails, the existing store is preserved unchanged (`ok: false` run recorded). Stale data with a visible failure is displayed; figures are never zeroed out.
- **Unexpected Shapes**: If Sage returns invalid JSON or missing envelopes, a `SageError("shape")` is thrown. Optional fields absent in Sage are left absent in canonical models (never defaulted to empty strings or zeroes).

## What I would still worry about

1. **Large Enterprise Pagination**: The test pack contains hundreds of records. For accounts with tens of thousands of invoices, concurrent paginated workers with backpressure and rate-limit backoff would be essential.
2. **Unallocated Credit Notes & Allocations**: In Buki, invoice `outstanding` is read from Sage's invoice record. If a business creates credit notes without allocating them to invoices in Sage, the invoice remains technically `part_paid` (e.g. £0.05), which can distort overdue counts unless credit notes are tracked and netted.
3. **Multi-Currency Normalization**: If a company invoices in multiple foreign currencies (e.g., EUR and USD against a GBP base), Buki intentionally does not convert currencies without exchange rates. A corporate setup would require daily ECB/Bank of England exchange rate feeds.

## Questions I asked

1. *How should bank account nominals be resolved?* Resolved by inspecting `GET /bank_accounts` which returns `ledger_account.id`, mapping transactions directly to canonical ledger accounts (`sage:<ledger_account.id>`).
2. *Should credit notes be mapped as negative invoices?* Determined to exclude credit notes from the canonical `Invoice` set to comply with the canonical contract where invoice totals are positive and lines represent purchase/sales expense items.
