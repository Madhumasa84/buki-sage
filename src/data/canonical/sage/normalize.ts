/**
 * Sage v3.1 raw to canonical normalization.
 *
 * Pure, no I/O, no network. Follows the absent-not-default rule: any field the
 * source did not supply is left completely absent (never null, "" or undefined).
 */

import type {
  BankTransaction,
  Invoice,
  InvoiceLine,
  LedgerAccount,
  Party,
} from "../types";
import type {
  SageBankAccount,
  SageBankTransaction,
  SageBankTransfer,
  SageContact,
  SageContactPayment,
  SageInvoice,
  SageLedgerAccount,
  SageOtherPayment,
} from "./raw/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanString(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  if (trimmed === "" || trimmed === "undefined" || trimmed === "null") return undefined;
  return trimmed;
}

function cleanDate(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const match = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const dateStr = match[0];
  const [y, m, d] = dateStr.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.toISOString().slice(0, 10) === dateStr ? dateStr : undefined;
}

/**
 * Resolves currency: checks record currency first; if absent, uses the authoritative
 * business base currency. Fails clearly when currency cannot be established.
 */
export function cleanCurrency(val: unknown, baseCurrency?: string): string {
  if (typeof val === "object" && val !== null && "id" in val) {
    const code = String((val as { id: unknown }).id).toUpperCase().trim();
    if (/^[A-Z]{3}$/.test(code)) return code;
  }
  if (typeof val === "string") {
    const code = val.toUpperCase().trim();
    if (/^[A-Z]{3}$/.test(code)) return code;
  }
  if (baseCurrency) {
    const code = baseCurrency.toUpperCase().trim();
    if (/^[A-Z]{3}$/.test(code)) return code;
  }
  throw new Error("Cannot establish currency: record does not specify currency and no authoritative base currency was provided");
}

function parseNumber(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const num = Number(val);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function normalizeAccountType(
  raw: SageLedgerAccount,
): "asset" | "liability" | "equity" | "income" | "expense" {
  const group = (raw.ledger_account_group?.id ?? raw.ledger_account_group?.displayed_as ?? "").toUpperCase();
  const typeId = (raw.ledger_account_type?.id ?? raw.ledger_account_type?.displayed_as ?? "").toUpperCase();
  const name = (raw.name ?? raw.displayed_as ?? "").toUpperCase();
  const combined = `${group} ${typeId} ${name}`;

  const nominal = Number(raw.nominal_code);
  if (combined.includes("ASSET") || combined.includes("BANK") || combined.includes("CASH")) return "asset";
  if (Number.isFinite(nominal) && nominal >= 1000 && nominal < 2000) return "asset";
  if (combined.includes("LIABILIT")) return "liability";
  if (Number.isFinite(nominal) && nominal >= 2000 && nominal < 3000) return "liability";
  if (combined.includes("EQUITY") || combined.includes("CAPITAL")) return "equity";
  if (Number.isFinite(nominal) && nominal >= 3000 && nominal < 4000) return "equity";
  if (combined.includes("INCOME") || combined.includes("SALES") || combined.includes("REVENUE")) return "income";
  if (Number.isFinite(nominal) && nominal >= 4000 && nominal < 5000) return "income";
  if (
    combined.includes("EXPENSE") ||
    combined.includes("OVERHEAD") ||
    combined.includes("PURCHASE") ||
    combined.includes("COST") ||
    combined.includes("DEPRECIAT")
  ) {
    return "expense";
  }

  // Fallback to nominal code ranges standard in UK accounting
  const codeNum = typeof raw.nominal_code === "number" ? raw.nominal_code : Number(raw.nominal_code);
  if (!Number.isNaN(codeNum)) {
    if (codeNum < 2000) return "asset";
    if (codeNum < 3000) return "liability";
    if (codeNum < 4000) return "equity";
    if (codeNum < 5000) return "income";
    return "expense";
  }

  return "expense";
}

export function normalizeAccount(raw: SageLedgerAccount): LedgerAccount {
  const name = cleanString(raw.name) ?? cleanString(raw.displayed_as) ?? `Account ${raw.nominal_code ?? raw.id}`;
  const code = cleanString(String(raw.nominal_code ?? ""));
  const sourceUpdatedAt = cleanString(raw.updated_at ?? raw.created_at);

  return {
    id: `sage:${raw.id}`,
    source: "sage",
    sourceId: raw.id,
    name,
    type: normalizeAccountType(raw),
    ...(code ? { code } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

export function normalizeAccounts(raw: SageLedgerAccount[]): LedgerAccount[] {
  return raw.map(normalizeAccount);
}

// ---------------------------------------------------------------------------
// Parties (Contacts)
// ---------------------------------------------------------------------------

export function normalizePartyKind(contactTypeIds?: string[]): "customer" | "supplier" | "both" {
  if (!Array.isArray(contactTypeIds) || contactTypeIds.length === 0) return "customer";
  const upper = contactTypeIds.map((t) => String(t).toUpperCase());
  const isCust = upper.some((t) => t.includes("CUSTOMER") || t.includes("CLIENT"));
  const isSupp = upper.some((t) => t.includes("VENDOR") || t.includes("SUPPLIER"));
  if (isCust && isSupp) return "both";
  if (isSupp) return "supplier";
  return "customer";
}

export function normalizeParty(raw: SageContact): Party {
  const name = cleanString(raw.name) ?? cleanString(raw.displayed_as) ?? `Contact ${raw.id}`;
  const kind = normalizePartyKind(raw.contact_type_ids);
  const email = cleanString(raw.email) ?? cleanString(raw.main_contact_person?.email);
  const sourceUpdatedAt = cleanString(raw.updated_at);

  return {
    id: `sage:${raw.id}`,
    source: "sage",
    sourceId: raw.id,
    name,
    kind,
    ...(email ? { email } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

export function normalizeParties(raw: SageContact[]): Party[] {
  return raw.map(normalizeParty);
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export function normalizeInvoiceStatus(
  status: unknown,
  total: number,
  outstanding: number,
): "draft" | "unpaid" | "part_paid" | "paid" | "void" {
  const statusStr = (
    typeof status === "object" && status !== null && "id" in status
      ? String((status as { id: unknown }).id)
      : String(status ?? "")
  )
    .toLowerCase()
    .trim();

  if (statusStr.includes("draft")) return "draft";
  if (statusStr.includes("void") || statusStr.includes("cancel")) return "void";
  if (statusStr.includes("part")) return "part_paid";
  if (statusStr.includes("unpaid")) return "unpaid";

  if (outstanding <= 0 && total > 0) return "paid";
  if (outstanding > 0 && outstanding < total) return "part_paid";
  if (statusStr.includes("paid")) {
    return outstanding <= 0 ? "paid" : "part_paid";
  }

  return "unpaid";
}

export function normalizeInvoice(
  raw: SageInvoice,
  kind: "sales" | "purchase",
  defaultAccountId = "acc-default",
  baseCurrency?: string,
): Invoice {
  const partySourceId = cleanString(raw.contact?.id) ?? "unknown-party";
  const number = cleanString(raw.invoice_number !== undefined ? String(raw.invoice_number) : undefined) ?? cleanString(raw.displayed_as);
  const date = cleanDate(raw.date) ?? new Date().toISOString().slice(0, 10);
  const dueDate = cleanDate(raw.due_date);
  const currency = cleanCurrency(raw.currency, baseCurrency);
  const total = parseNumber(raw.total_amount) ?? parseNumber(raw.total) ?? 0;
  const rawOutstanding = parseNumber(raw.outstanding_amount);
  const outstanding = rawOutstanding !== undefined ? Math.min(rawOutstanding, total) : total;
  const status = normalizeInvoiceStatus(raw.status, total, outstanding);
  const sourceUpdatedAt = cleanString(raw.updated_at);

  const rawLines = Array.isArray(raw.invoice_lines) ? raw.invoice_lines : [];
  const lines: InvoiceLine[] = rawLines.map((line) => {
    const description = cleanString(line.description) ?? cleanString(raw.displayed_as) ?? "Line item";
    const lineAccountId = cleanString(line.ledger_account?.id) ?? defaultAccountId;
    const net = parseNumber(line.net_amount) ?? parseNumber(line.total_amount) ?? parseNumber(line.unit_price) ?? 0;
    return {
      description,
      accountId: `sage:${lineAccountId}`,
      net,
    };
  });

  if (lines.length === 0) {
    lines.push({
      description: number ?? `${kind} invoice`,
      accountId: `sage:${defaultAccountId}`,
      net: total,
    });
  }

  return {
    id: `sage:${raw.id}`,
    source: "sage",
    sourceId: raw.id,
    kind,
    partyId: `sage:${partySourceId}`,
    date,
    status,
    currency,
    total,
    outstanding: status === "paid" || status === "void" ? 0 : outstanding,
    lines,
    ...(number ? { number } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

export function normalizeInvoices(
  sales: SageInvoice[],
  purchases: SageInvoice[],
  defaultSalesAccount = "acc-4000",
  defaultPurchaseAccount = "acc-7000",
  baseCurrency?: string,
): Invoice[] {
  const normSales = sales.map((si) => normalizeInvoice(si, "sales", defaultSalesAccount, baseCurrency));
  const normPurchases = purchases.map((pi) => normalizeInvoice(pi, "purchase", defaultPurchaseAccount, baseCurrency));
  return [...normSales, ...normPurchases];
}

// ---------------------------------------------------------------------------
// Bank Transactions
// ---------------------------------------------------------------------------

const NON_BANKING_TRANSACTION_TYPES = new Set([
  "SALES_INVOICE",
  "PURCHASE_INVOICE",
  "SALES_CREDIT_NOTE",
  "PURCHASE_CREDIT_NOTE",
  "JOURNAL",
]);

/**
 * Normalizes an Other Payment or Other Receipt into a canonical BankTransaction.
 * Throws visibly if the record does not link to a mapped canonical bank account.
 */
export function normalizeOtherPayment(
  raw: SageOtherPayment,
  bankAccountToLedgerMap: Map<string, string>,
  baseCurrency?: string,
): BankTransaction {
  const rawBankId = cleanString(raw.bank_account?.id);
  const ledgerAccountId = rawBankId ? bankAccountToLedgerMap.get(rawBankId) : undefined;
  if (!ledgerAccountId) {
    throw new Error(
      `Bank movement "${raw.id}" (${raw.reference ?? raw.displayed_as ?? "unnamed"}) references unmapped bank account "${rawBankId ?? "missing"}"; cannot map to canonical ledger account`,
    );
  }

  const date = cleanDate(raw.date) ?? new Date().toISOString().slice(0, 10);
  const currency = cleanCurrency(raw.currency, baseCurrency);
  const rawAmount = parseNumber(raw.total_amount) ?? parseNumber(raw.net_amount) ?? 0;
  const typeId = String(raw.transaction_type?.id ?? "").toUpperCase();
  // Money out is negative, money in is positive
  const amount = typeId.includes("RECEIPT") ? Math.abs(rawAmount) : -Math.abs(rawAmount);

  const description =
    cleanString(raw.reference) ??
    cleanString(raw.payment_lines?.[0]?.details) ??
    cleanString(raw.displayed_as) ??
    "Other payment";

  const accountId = cleanString(raw.payment_lines?.[0]?.ledger_account?.id);
  const partyId = cleanString(raw.contact?.id);
  const sourceUpdatedAt = cleanString(raw.updated_at);

  return {
    id: `sage:${raw.id}`,
    source: "sage",
    sourceId: raw.id,
    bankAccountId: `sage:${ledgerAccountId}`,
    date,
    amount,
    currency,
    description,
    ...(accountId ? { accountId: `sage:${accountId}` } : {}),
    ...(partyId ? { partyId: `sage:${partyId}` } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

/**
 * Normalizes a Customer Receipt or Supplier Payment into a canonical BankTransaction.
 * Throws visibly if the record does not link to a mapped canonical bank account.
 */
export function normalizeContactPayment(
  raw: SageContactPayment,
  bankAccountToLedgerMap: Map<string, string>,
  baseCurrency?: string,
): BankTransaction {
  const rawBankId = cleanString(raw.bank_account?.id);
  const ledgerAccountId = rawBankId ? bankAccountToLedgerMap.get(rawBankId) : undefined;
  if (!ledgerAccountId) {
    throw new Error(
      `Contact payment "${raw.id}" (${raw.reference ?? raw.displayed_as ?? "unnamed"}) references unmapped bank account "${rawBankId ?? "missing"}"; cannot map to canonical ledger account`,
    );
  }

  const date = cleanDate(raw.date) ?? new Date().toISOString().slice(0, 10);
  const currency = cleanCurrency(raw.currency, baseCurrency);
  const rawAmount = parseNumber(raw.total_amount) ?? parseNumber(raw.net_amount) ?? 0;
  const typeId = String(raw.transaction_type?.id ?? "").toUpperCase();

  // Customer receipt or supplier refund is money in; vendor payment or customer refund is money out
  const isIncoming = typeId.includes("RECEIPT") || (typeId.includes("REFUND") && typeId.includes("VENDOR"));
  const amount = isIncoming ? Math.abs(rawAmount) : -Math.abs(rawAmount);

  const description =
    cleanString(raw.reference) ??
    cleanString(raw.displayed_as) ??
    "Contact payment";

  const partyId = cleanString(raw.contact?.id);
  const sourceUpdatedAt = cleanString(raw.updated_at);

  return {
    id: `sage:${raw.id}`,
    source: "sage",
    sourceId: raw.id,
    bankAccountId: `sage:${ledgerAccountId}`,
    date,
    amount,
    currency,
    description,
    ...(partyId ? { partyId: `sage:${partyId}` } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

/**
 * Normalizes a Bank Transfer into two canonical BankTransactions (from and to legs).
 * Throws visibly if either bank account mapping is missing.
 */
export function normalizeBankTransfer(
  raw: SageBankTransfer,
  bankAccountToLedgerMap: Map<string, string>,
  baseCurrency?: string,
): BankTransaction[] {
  const date = cleanDate(raw.date) ?? new Date().toISOString().slice(0, 10);
  const currency = cleanCurrency(raw.currency, baseCurrency);
  const rawAmount = parseNumber(raw.amount) ?? 0;
  const description = cleanString(raw.reference) ?? cleanString(raw.description) ?? "Bank transfer";
  const sourceUpdatedAt = cleanString(raw.updated_at);

  const fromBankId = cleanString(raw.from_bank_account?.id);
  const fromLedger = fromBankId ? bankAccountToLedgerMap.get(fromBankId) : undefined;
  if (!fromLedger) {
    throw new Error(
      `Bank transfer "${raw.id}" outgoing leg references unmapped bank account "${fromBankId ?? "missing"}"`,
    );
  }

  const toBankId = cleanString(raw.to_bank_account?.id);
  const toLedger = toBankId ? bankAccountToLedgerMap.get(toBankId) : undefined;
  if (!toLedger) {
    throw new Error(
      `Bank transfer "${raw.id}" incoming leg references unmapped bank account "${toBankId ?? "missing"}"`,
    );
  }

  return [
    {
      id: `sage:${raw.id}:from`,
      source: "sage",
      sourceId: `${raw.id}:from`,
      bankAccountId: `sage:${fromLedger}`,
      date,
      amount: -Math.abs(rawAmount),
      currency,
      description: `${description} (out)`,
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    },
    {
      id: `sage:${raw.id}:to`,
      source: "sage",
      sourceId: `${raw.id}:to`,
      bankAccountId: `sage:${toLedger}`,
      date,
      amount: Math.abs(rawAmount),
      currency,
      description: `${description} (in)`,
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    },
  ];
}

/**
 * Normalizes a generic bank transaction record. Rejects general invoice postings and throws
 * on genuine bank movements without valid bank account mappings.
 */
export function normalizeBankTransaction(
  raw: SageBankTransaction,
  bankAccountToLedgerMap: Map<string, string> = new Map(),
  baseCurrency?: string,
): BankTransaction | null {
  const typeId = String(raw.bank_transaction_type?.id ?? "").toUpperCase();
  if (NON_BANKING_TRANSACTION_TYPES.has(typeId)) {
    return null;
  }

  const rawBankAccId = cleanString(raw.bank_account?.id);
  const ledgerAccId = rawBankAccId
    ? bankAccountToLedgerMap.get(rawBankAccId) ?? cleanString(raw.bank_account?.ledger_account?.id)
    : cleanString(raw.bank_account?.ledger_account?.id);

  if (!ledgerAccId) {
    throw new Error(
      `Bank transaction "${raw.id}" references unmapped bank account "${rawBankAccId ?? "missing"}"; cannot map to canonical ledger account`,
    );
  }

  const date = cleanDate(raw.date) ?? new Date().toISOString().slice(0, 10);
  const currency = cleanCurrency(raw.currency, baseCurrency);
  const description =
    cleanString(raw.description) ??
    cleanString(raw.reference) ??
    "Bank transaction";

  let amount = parseNumber(raw.amount) ?? parseNumber(raw.total_amount) ?? parseNumber(raw.net_amount) ?? 0;
  if (typeId.includes("PAYMENT") || typeId.includes("EXPENSE") || typeId.includes("TRANSFER_OUT")) {
    amount = -Math.abs(amount);
  } else if (typeId.includes("RECEIPT") || typeId.includes("DEPOSIT") || typeId.includes("TRANSFER_IN")) {
    amount = Math.abs(amount);
  }

  const accountId = cleanString(raw.ledger_account?.id);
  const partyId = cleanString(raw.contact?.id);
  const sourceUpdatedAt = cleanString(raw.updated_at);

  return {
    id: `sage:${raw.id}`,
    source: "sage",
    sourceId: raw.id,
    bankAccountId: `sage:${ledgerAccId}`,
    date,
    amount,
    currency,
    description,
    ...(accountId ? { accountId: `sage:${accountId}` } : {}),
    ...(partyId ? { partyId: `sage:${partyId}` } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

export function normalizeBankTransactions(
  raw: SageBankTransaction[],
  bankAccounts: SageBankAccount[] = [],
  baseCurrency?: string,
): BankTransaction[] {
  const bankToLedger = new Map<string, string>();
  for (const ba of bankAccounts) {
    if (ba.id && ba.ledger_account?.id) {
      bankToLedger.set(ba.id, ba.ledger_account.id);
    }
  }

  const out: BankTransaction[] = [];
  for (const bt of raw) {
    const norm = normalizeBankTransaction(bt, bankToLedger, baseCurrency);
    if (norm) out.push(norm);
  }
  return out;
}
