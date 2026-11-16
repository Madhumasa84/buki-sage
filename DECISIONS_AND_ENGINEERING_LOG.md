# Engineering Decision & AI Collaboration Log: Sage Accounting Connector

**Project:** Buki Connector Kit — Sage Business Cloud Accounting (v3.1)  
**Author:** Candidate Submission  
**Date:** November 2026  
**Repository:** `https://github.com/Madhumasa84/buki-sage.git`

---

## 1. Executive Summary

This document logs the architectural decisions, accounting trade-offs, fault-tolerance mechanisms, and AI collaboration workflow undertaken while building the production-ready Sage Business Cloud Accounting (v3.1) connector for Buki.

The primary objective was integrating Sage's REST API into Buki's canonical financial types (`LedgerAccount`, `Party`, `Invoice`, `BankTransaction`) with zero data loss, strict idempotency, audit-grade accounting semantics, and complete fault visibility.

---

## 2. Chronological Decision Log

### Decision 1: Authentication Architecture — Browser-Based Consent vs. Headless Scraping
* **Context:** Sage OAuth 2.0 requires an interactive three-legged authorization code grant with user consent.
* **Options Considered:**
  1. *Headless Browser Scraping:* Automating login via Puppeteer/Playwright with stored passwords.
  2. *Interactive Local CLI Flow (`npm run sage:auth`):* Starting a lightweight HTTP server on port 3000, launching the user's browser to Sage's official consent screen, capturing the redirect code, and persisting tokens locally.
* **Decision Taken:** Implemented Option 2.
* **Rationale:** Scraping credentials violates OAuth security standards, breaks multi-factor authentication (MFA), and is fragile to UI updates. The CLI approach maintains strict OAuth 2.0 compliance, and once authorized, background token rotation operates without user interaction.

---

### Decision 2: Single-Use Rolling Refresh Token Mutex Lock
* **Context:** Sage issues rolling refresh tokens. When a refresh token is used, Sage issues a new pair and **immediately invalidates the previous refresh token**.
* **Problem Encountered:** Under concurrent execution (e.g. parallel requests for accounts, contacts, and invoices), multiple requests detected an expired access token simultaneously and attempted parallel refreshes. Sage rejected subsequent requests with `{"error": "invalid_grant", "error_description": "the submitted refresh_token is invalid"}`.
* **Decision Taken:** Implemented a single-flight mutex lock (`refreshPromise`) in `src/data/canonical/sage/token.ts`.
* **Rationale:** Guarantees that only one HTTP POST is made to `/oauth2/token` at any time. All concurrent consumers await the same promise and receive the fresh access token, eliminating race conditions.

---

### Decision 3: Accrual vs. Cash Accounting Semantics (Bank Movements)
* **Context:** Sage's general transaction endpoint lists all ledger activity, including sales invoice and purchase invoice postings (`SALES_INVOICE`, `PURCHASE_INVOICE`).
* **Problem Encountered:** Mapping general ledger transactions directly into canonical `BankTransaction` caused invoices to be treated as bank movements, double-counting cash and inventing cash flow before payments were received.
* **Decision Taken:** Strictly rejected invoice postings as bank transactions. Restricted `BankTransaction` imports exclusively to real bank movements:
  * `GET /other_payments` (direct expenses/fees)
  * `GET /contact_payments` (customer receipts and supplier payments)
  * `GET /bank_transfers` (inter-account transfers, normalized as matching debit and credit legs)
* **Rationale:** In standard accounting, issuing an invoice is an accounts receivable transaction (Dr Debtors, Cr Revenue), **not a cash transaction**. Cash must only reflect actual movements into or out of bank accounts.

---

### Decision 4: Chart of Accounts & Bank Mapping (Loud Failures vs. Silent Defaults)
* **Context:** Bank transactions in Sage reference a `bank_account.id`, which corresponds to an operational bank account that points to a general ledger nominal code (`1200`, `1210`, etc.).
* **Decision Taken:**
  1. Queried `GET /ledger_accounts?attributes=all` and `GET /bank_accounts` to establish an explicit mapping from bank account IDs to canonical ledger accounts (`sage:<ledger_account.id>`).
  2. If a bank transaction references an unrecognized bank account, the normalizer throws an **explicit, visible error** (`references unmapped bank account`), rather than falling back to an invented "Default Bank Account".
* **Rationale:** Fabricating fallback bank accounts introduces ghost balances and silent ledger drift. In accounting software, missing account mappings must fail fast and loud so administrators can map the nominal code.

---

### Decision 5: Authoritative Base Currency Resolution
* **Context:** Sage businesses operate in an authoritative base currency (e.g. `GBP`, `EUR`, `USD`), while individual transactions may be multi-currency.
* **Decision Taken:** Removed all hardcoded `"GBP"` fallback strings. Built `SageClient.baseCurrency()` which queries `GET /financial_settings` for `base_currency`. If currency cannot be determined from either the record or settings, the normalizer throws an explicit exception.
* **Rationale:** Guessing currency corrupts financial reporting and leads to silent conversion bugs. Authoritative dynamic resolution guarantees international compatibility.

---

### Decision 6: The "Absent-Not-Default" Schema Rule
* **Context:** Canonical types specify optional fields (e.g. `Party.email`, `Invoice.dueDate`, `Invoice.reference`).
* **Decision Taken:** When Sage omits an optional field or supplies an empty string, the key is omitted entirely (`delete obj[key]` or conditional assignment), rather than defaulted to `""`, `null`, or synthetic dates.
* **Rationale:** Prevents downstream systems from misinterpreting synthetic values (such as an empty string being treated as a valid email or a default date being treated as an overdue deadline).

---

### Decision 7: Intentional Scope Exclusions
* **Credit Notes (`/sales_credit_notes`, `/purchase_credit_notes`):**
  * *Decision:* Excluded from canonical `Invoice[]`.
  * *Rationale:* Canonical `Invoice` requires positive amounts (`total >= 0`). Forcing negative credit notes into the trade invoice set violates schema contracts and distorts operational sales/purchase analysis. Unallocated credit notes leave tiny balances on invoices (e.g. £0.05 on `SI-69`), which accurately reflects Sage's unallocated state.
* **Contact Opening Balances (`/contact_opening_balances`):**
  * *Decision:* Excluded from operational trade invoices.
  * *Rationale:* Opening balances represent historical migration transfers (e.g. from Sage 50), not operational invoices with product line items and tax breakdowns.
* **Manual Nominal Journals (`/journals`):**
  * *Decision:* Excluded from trade invoices and bank movements.
  * *Rationale:* Journals adjust ledger accounts (depreciation, accruals) without trade party or invoice line semantics. Buki has no canonical `Journal` type; contorting them into invoices would corrupt AR/AP ledgers.

---

### Decision 8: Automated Test-Pack Import (Newman Adaptation)
* **Context:** The official Sage test pack consists of 11 sequential Postman folders with interdependent foreign keys (accounts -> contacts -> products -> invoices -> payments).
* **Problem Encountered:** Newman folder-level runs do not persist in-memory JavaScript environment dictionaries across isolated executions. Additionally, product descriptions with unescaped quotes (`15" Monitor`) and a test-data date bug (`due_date < date` on `MOR001`) caused 422 rejections.
* **Decision Taken:**
  1. Built an automated runner (`scripts/run-import-stage.ts`) that serializes environment state to `.data/newman-env.json` after each stage.
  2. Added string escaping for product descriptions (`split('"').join('\\"')`).
  3. Added date normalization clamping `dueDate = (due_date < date) ? date : due_date`.
* **Rationale:** Enabled fully automated, idempotent test-pack ingestion without requiring the Postman desktop GUI.

---

### Decision 9: Incremental Sync & Edit Detection Strategy
* **Context:** Sync must detect edits in Sage without re-fetching thousands of unchanged records.
* **Decision Taken:**
  * Incremental sync queries endpoints using `updated_or_created_since` timestamps.
  * In-memory reconciliation compares returned timestamps (`updated_at`) against cached entities in `.data/store.json`.
* **Rationale:** Verified live: editing invoice `SI-1` via `scripts/edit-invoice.ts` resulted in the scheduled cron detecting the change on the next loop (`pulled: 1, changed: 1`) without triggering full table scans.

---

### Decision 10: Atomic Store Invariant & Stale State Preservation
* **Context:** If Sage experiences an outage midway through a sync, partial data must not overwrite valid records.
* **Decision Taken:** `src/lib/sync/runSync.ts` conducts all API fetches in memory. Disk writes to `.data/store.json` only occur if all domain providers succeed. If a failure occurs, the run is logged as `ok: false`, and the previous store remains completely untouched.
* **Rationale:** Guarantees that downstream commands (`show -- finance`, `ask`) report stale but consistent data rather than zeroing out metrics or showing corrupted states.

---

## 3. AI Collaboration & Verification Log

### What AI Wrote vs. What I Checked and Corrected

| Component | What AI Generated | What I Audited, Caught & Corrected |
| :--- | :--- | :--- |
| **Raw Types (`types.ts`)** | Initial TypeScript interfaces from Sage documentation. | Verified optional vs required properties against actual API JSON responses. |
| **Bank Normalization** | Suggested importing all general ledger transactions as bank entries. | **Rejected & Corrected:** Caught that invoice postings are accrual, not cash. Restricted import strictly to actual bank payments and transfers. |
| **Currency Handling** | Defaulted missing currency values to `"GBP"`. | **Rejected & Corrected:** Removed hardcoded string. Enforced authoritative lookup via `/financial_settings` and explicit failure on missing currency. |
| **Token Management** | Standard async token refresh function. | **Debugged & Corrected:** Diagnosed concurrent refresh collisions under parallel requests. Designed and tested the `refreshPromise` mutex lock. |
| **Newman Import** | Standard Newman execution scripts. | **Fixed & Adapted:** Solved environment persistence across stages, escaped quotes in product descriptions, and patched the `MOR001` date inversion bug. |
| **Software Spend Reconciliation** | Generated basic filter for software spend. | **Hand-Audited:** Reconciled question output against raw purchase invoice `OV-44817` lines 1 & 2 under nominal code `7550` before VAT to ensure £2,350 was exact. |
| **Fault-Handling Tests** | Vitest test templates. | **Authored & Executed:** Wrote 15 targeted fault-handling unit tests in `client.test.ts` and `token.test.ts` to ensure 100% of claimed error modes were executed and proven. |

### Philosophy on AI Usage
AI served as a high-speed drafting partner for boilerplate code and type definitions. Every architectural boundary, accounting semantic rule, concurrency lock, and edge-case correction was actively directed, scrutinized, and verified by me.

---

## 4. Key Positives & System Strengths

1. **Strict Idempotency:** Back-to-back syncs without source edits report `pulled: 676, added: 0, changed: 0, removed: 0`.
2. **Accounting Integrity:** Cash represents the true sum of imported bank movements (£497 across 4 accounts); invoices represent true trade receivables (£109,476 across 49 overdue invoices).
3. **Flawless Validation:** 0 errors and 0 warnings against Buki’s canonical schema across all 676 records.
4. **Resilient OAuth Concurrency:** Single-use rolling refresh tokens are protected against race conditions by an in-flight mutex.
5. **Comprehensive Test Suite:** 55 passing unit tests (`npm test`) and strict TypeScript typechecking (`npm run typecheck`) with zero errors.

---

## 5. Bottlenecks & System Limits (Where It Will Break)

1. **Large Enterprise Pagination (>50k Invoices):**
   * *Limit:* `fetchPaginated()` fetches pages sequentially (100 items per request). A company with 50,000 invoices would require 500 serial HTTP calls, risking HTTP 429 rate limiting or timeouts.
   * *Mitigation Needed:* Implement parallel worker pools with rate-limit backpressure, cursor-based chunking, and exponential backoff.
2. **Hard Deletions in Sage:**
   * *Limit:* `updated_or_created_since` filters return records that were modified. If an invoice is deleted in Sage, no update timestamp is generated, leaving an orphaned record in Buki.
   * *Mitigation Needed:* Implement a periodic (e.g. weekly) full reconciliation audit that diffs remote IDs against local IDs to prune deletions.
3. **Unallocated Credit Notes:**
   * *Limit:* In Sage, issuing a credit note does not automatically allocate it to an invoice. For example, invoice `SI-69` shows £0.05 outstanding because credit note `SC-8` (£0.05) remains unallocated in Sage.
   * *Mitigation Needed:* Build a dedicated credit note allocation engine to calculate effective net exposure.
4. **Multi-Currency Without Real-Time Spot Rates:**
   * *Limit:* Multi-currency amounts cannot be aggregated into a single cash or overdue figure without exchange rates.
   * *Mitigation Needed:* Integrate an external daily spot rate feed (e.g. Bank of England or ECB) for multi-currency conversion.
5. **New Unmapped Bank Accounts in Sage:**
   * *Limit:* If a business user creates a new bank account in Sage without configuring its nominal code mapping, the connector throws an error and halts sync.
   * *Mitigation Needed:* Build an administrative alert/mapping screen to prompt users to map newly detected bank accounts.
