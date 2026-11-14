/**
 * The Sage Finance provider: wires client + normalize into the FinanceProvider contract.
 *
 * Implements health(), accounts(), parties(), invoices(), and bankTransactions().
 * Does not swallow errors during data pulls; runSync handles and logs failures.
 */

import type { BankTransaction } from "../types";
import type { FinanceProvider } from "../providers/types";
import { SageClient, SageError, describe } from "./client";
import {
  normalizeAccounts,
  normalizeBankTransfer,
  normalizeContactPayment,
  normalizeInvoices,
  normalizeOtherPayment,
  normalizeParties,
} from "./normalize";
import { configFromEnv } from "./token";

export const sageProvider: FinanceProvider = {
  source: "sage",

  async health() {
    try {
      const config = configFromEnv();
      const client = new SageClient(config);
      const [accounts, baseCurrency] = await Promise.all([
        client.ledgerAccounts(),
        client.baseCurrency(),
      ]);
      return {
        ok: true,
        detail: `${accounts.length} ledger accounts in Sage business "${config.businessId}" (base currency: ${baseCurrency})`,
      };
    } catch (err) {
      const kind = err instanceof SageError ? err.kind : "unknown";
      return { ok: false, detail: `${kind}: ${describe(err)}` };
    }
  },

  async accounts() {
    const client = new SageClient(configFromEnv());
    const raw = await client.ledgerAccounts();
    return normalizeAccounts(raw);
  },

  async parties() {
    const client = new SageClient(configFromEnv());
    const raw = await client.contacts();
    return normalizeParties(raw);
  },

  async invoices(since?: string) {
    const client = new SageClient(configFromEnv());
    const [sales, purchases, baseCurrency] = await Promise.all([
      client.salesInvoices(since),
      client.purchaseInvoices(since),
      client.baseCurrency(),
    ]);
    return normalizeInvoices(sales, purchases, "acc-4000", "acc-7000", baseCurrency);
  },

  async bankTransactions(since?: string) {
    const client = new SageClient(configFromEnv());
    const [bankAccounts, baseCurrency, otherPayments, contactPayments, bankTransfers] = await Promise.all([
      client.bankAccounts(),
      client.baseCurrency(),
      client.otherPayments(since),
      client.contactPayments(since),
      client.bankTransfers(since),
    ]);

    const bankToLedger = new Map<string, string>();
    for (const ba of bankAccounts) {
      if (ba.id && ba.ledger_account?.id) {
        bankToLedger.set(ba.id, ba.ledger_account.id);
      }
    }

    const txns: BankTransaction[] = [];

    for (const op of otherPayments) {
      const norm = normalizeOtherPayment(op, bankToLedger, baseCurrency);
      if (norm) txns.push(norm);
    }

    for (const cp of contactPayments) {
      const norm = normalizeContactPayment(cp, bankToLedger, baseCurrency);
      if (norm) txns.push(norm);
    }

    for (const bt of bankTransfers) {
      const norms = normalizeBankTransfer(bt, bankToLedger, baseCurrency);
      txns.push(...norms);
    }

    // Sort chronologically by date
    return txns.sort((a, b) => a.date.localeCompare(b.date));
  },
};
