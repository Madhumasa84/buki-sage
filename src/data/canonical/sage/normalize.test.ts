import { describe, expect, it } from "vitest";
import {
  cleanCurrency,
  normalizeAccount,
  normalizeAccountType,
  normalizeAccounts,
  normalizeBankTransaction,
  normalizeBankTransactions,
  normalizeBankTransfer,
  normalizeContactPayment,
  normalizeInvoice,
  normalizeInvoiceStatus,
  normalizeInvoices,
  normalizeOtherPayment,
  normalizeParties,
  normalizeParty,
  normalizePartyKind,
} from "./normalize";
import { validateFinanceSet } from "../../../lib/check/validate";
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

describe("Sage Normalize", () => {
  describe("Accounts", () => {
    it("correctly identifies account types from groups and nominal codes", () => {
      expect(
        normalizeAccountType({
          id: "1",
          ledger_account_group: { id: "BANK" },
          nominal_code: 1200,
        }),
      ).toBe("asset");

      expect(
        normalizeAccountType({
          id: "2",
          ledger_account_group: { id: "CURRENT_LIABILITIES" },
          nominal_code: 2100,
        }),
      ).toBe("liability");

      expect(
        normalizeAccountType({
          id: "3",
          ledger_account_group: { id: "EQUITY" },
          nominal_code: 3000,
        }),
      ).toBe("equity");

      expect(
        normalizeAccountType({
          id: "4",
          ledger_account_group: { id: "SALES" },
          nominal_code: 4000,
        }),
      ).toBe("income");

      expect(
        normalizeAccountType({
          id: "5",
          ledger_account_group: { id: "OVERHEADS" },
          nominal_code: 7500,
        }),
      ).toBe("expense");
    });

    it("leaves absent optional fields when not supplied (absent-not-default rule)", () => {
      const raw: SageLedgerAccount = {
        id: "acc-100",
        name: "Test Account",
        ledger_account_group: { id: "BANK" },
      };
      const account = normalizeAccount(raw);

      expect(account.id).toBe("sage:acc-100");
      expect(account.source).toBe("sage");
      expect(account.name).toBe("Test Account");
      expect(account.type).toBe("asset");
      expect("code" in account).toBe(false);
      expect("sourceUpdatedAt" in account).toBe(false);
    });
  });

  describe("Parties", () => {
    it("determines party kind correctly", () => {
      expect(normalizePartyKind(["CUSTOMER"])).toBe("customer");
      expect(normalizePartyKind(["VENDOR"])).toBe("supplier");
      expect(normalizePartyKind(["CUSTOMER", "VENDOR"])).toBe("both");
    });

    it("omits email when not present (no empty string, null, or undefined)", () => {
      const raw: SageContact = {
        id: "con-1",
        name: "Acme Corp",
        contact_type_ids: ["CUSTOMER"],
        email: "",
      };
      const party = normalizeParty(raw);
      expect(party.name).toBe("Acme Corp");
      expect("email" in party).toBe(false);
    });
  });

  describe("Currency Resolution (No Hardcoded Fallback)", () => {
    it("uses record currency when explicitly provided", () => {
      expect(cleanCurrency("EUR", "GBP")).toBe("EUR");
      expect(cleanCurrency({ id: "USD" }, "GBP")).toBe("USD");
    });

    it("falls back to authoritative base currency when record currency is absent", () => {
      expect(cleanCurrency(undefined, "GBP")).toBe("GBP");
      expect(cleanCurrency(null, "EUR")).toBe("EUR");
    });

    it("fails clearly when currency cannot be established", () => {
      expect(() => cleanCurrency(undefined, undefined)).toThrow(
        /Cannot establish currency: record does not specify currency and no authoritative base currency was provided/,
      );
      expect(() => cleanCurrency("", "")).toThrow(
        /Cannot establish currency: record does not specify currency and no authoritative base currency was provided/,
      );
    });
  });

  describe("Invoices", () => {
    it("normalizes status accurately based on status and outstanding amounts", () => {
      expect(normalizeInvoiceStatus("DRAFT", 1000, 1000)).toBe("draft");
      expect(normalizeInvoiceStatus("VOID", 1000, 0)).toBe("void");
      expect(normalizeInvoiceStatus("PAID", 1000, 0)).toBe("paid");
      expect(normalizeInvoiceStatus("PART_PAID", 1000, 400)).toBe("part_paid");
      expect(normalizeInvoiceStatus("UNPAID", 1000, 1000)).toBe("unpaid");
    });

    it("omits dueDate when not present (never default)", () => {
      const raw: SageInvoice = {
        id: "si-1",
        contact: { id: "con-1" },
        invoice_number: "INV-001",
        date: "2026-10-01",
        currency: "USD",
        total_amount: 500,
        outstanding_amount: 500,
        status: { id: "UNPAID" },
        invoice_lines: [
          {
            description: "Services",
            ledger_account: { id: "acc-4000" },
            net_amount: 500,
          },
        ],
      };
      const invoice = normalizeInvoice(raw, "sales", "acc-4000", "USD");
      expect("dueDate" in invoice).toBe(false);
      expect(invoice.lines[0].accountId).toBe("sage:acc-4000");
    });
  });

  describe("Bank Transactions & Movement Semantics", () => {
    const bankMap = new Map([["bank-1200", "ledger-acc-1200"]]);

    it("rejects invoice postings as bank movements (does not fabricate default bank account)", () => {
      const rawInvoiceTx: SageBankTransaction = {
        id: "tx-inv-1",
        date: "2026-09-15",
        total_amount: 11400,
        reference: "INV-TEST-001",
        bank_transaction_type: { id: "SALES_INVOICE" },
        // No bank_account
      };

      const result = normalizeBankTransaction(rawInvoiceTx, bankMap, "GBP");
      expect(result).toBeNull();
    });

    it("produces a visible failure when a genuine bank movement has a missing bank account mapping", () => {
      const rawOrphanTx: SageBankTransaction = {
        id: "tx-orphan-1",
        date: "2026-10-01",
        amount: 100,
        bank_account: { id: "unknown-bank-id" },
        bank_transaction_type: { id: "PAYMENT" },
      };

      expect(() => normalizeBankTransaction(rawOrphanTx, bankMap, "GBP")).toThrow(
        /references unmapped bank account "unknown-bank-id"/,
      );

      const rawOrphanPayment: SageOtherPayment = {
        id: "op-orphan",
        date: "2026-10-01",
        total_amount: 100,
        reference: "ORPHAN-FEE",
        bank_account: { id: "unknown-bank-id" },
        transaction_type: { id: "OTHER_PAYMENT" },
      };

      expect(() => normalizeOtherPayment(rawOrphanPayment, bankMap, "GBP")).toThrow(
        /references unmapped bank account "unknown-bank-id"/,
      );

      const rawOrphanContactPayment: SageContactPayment = {
        id: "cp-orphan",
        date: "2026-10-01",
        total_amount: 150,
        bank_account: { id: "unknown-bank-id" },
        transaction_type: { id: "CUSTOMER_RECEIPT" },
      };

      expect(() => normalizeContactPayment(rawOrphanContactPayment, bankMap, "GBP")).toThrow(
        /references unmapped bank account "unknown-bank-id"/,
      );

      const rawOrphanTransfer: SageBankTransfer = {
        id: "bt-orphan",
        date: "2026-10-01",
        amount: 200,
        from_bank_account: { id: "unknown-bank-id" },
        to_bank_account: { id: "bank-1200" },
      };

      expect(() => normalizeBankTransfer(rawOrphanTransfer, bankMap, "GBP")).toThrow(
        /outgoing leg references unmapped bank account "unknown-bank-id"/,
      );
    });

    it("normalizes other_payments with correct signs and ledger account mapping", () => {
      const payment: SageOtherPayment = {
        id: "op-1",
        date: "2026-11-01",
        total_amount: 50,
        reference: "DOMAIN-FEE",
        bank_account: { id: "bank-1200" },
        transaction_type: { id: "OTHER_PAYMENT" },
        payment_lines: [
          {
            details: "Domain renewal",
            ledger_account: { id: "ledger-acc-7550" },
            net_amount: 50,
          },
        ],
      };

      const canonical = normalizeOtherPayment(payment, bankMap, "GBP");
      expect(canonical).not.toBeNull();
      expect(canonical?.id).toBe("sage:op-1");
      expect(canonical?.bankAccountId).toBe("sage:ledger-acc-1200");
      expect(canonical?.amount).toBe(-50); // Money out is negative
      expect(canonical?.currency).toBe("GBP");
      expect(canonical?.description).toBe("DOMAIN-FEE");
      expect(canonical?.accountId).toBe("sage:ledger-acc-7550");
    });

    it("normalizes other receipts as positive amounts", () => {
      const receipt: SageOtherPayment = {
        id: "or-1",
        date: "2026-11-02",
        total_amount: 200,
        reference: "INTEREST",
        bank_account: { id: "bank-1200" },
        transaction_type: { id: "OTHER_RECEIPT" },
      };

      const canonical = normalizeOtherPayment(receipt, bankMap, "GBP");
      expect(canonical?.amount).toBe(200); // Money in is positive
    });

    it("normalizes contact_payments (customer receipt vs vendor payment)", () => {
      const custReceipt: SageContactPayment = {
        id: "cp-1",
        date: "2026-10-20",
        total_amount: 1000,
        reference: "REC-001",
        bank_account: { id: "bank-1200" },
        contact: { id: "cust-1" },
        transaction_type: { id: "CUSTOMER_RECEIPT" },
      };

      const vendorPayment: SageContactPayment = {
        id: "cp-2",
        date: "2026-10-22",
        total_amount: 400,
        reference: "PAY-001",
        bank_account: { id: "bank-1200" },
        contact: { id: "supp-1" },
        transaction_type: { id: "VENDOR_PAYMENT" },
      };

      const normRec = normalizeContactPayment(custReceipt, bankMap, "GBP");
      const normPay = normalizeContactPayment(vendorPayment, bankMap, "GBP");

      expect(normRec?.amount).toBe(1000); // Money in
      expect(normRec?.partyId).toBe("sage:cust-1");

      expect(normPay?.amount).toBe(-400); // Money out
      expect(normPay?.partyId).toBe("sage:supp-1");
    });

    it("normalizes bank transfers into outgoing and incoming legs", () => {
      const map = new Map([
        ["bank-current", "acc-1200"],
        ["bank-savings", "acc-1210"],
      ]);

      const transfer: SageBankTransfer = {
        id: "bt-10",
        date: "2026-10-25",
        amount: 1500,
        reference: "SWEEP",
        from_bank_account: { id: "bank-current" },
        to_bank_account: { id: "bank-savings" },
      };

      const legs = normalizeBankTransfer(transfer, map, "GBP");
      expect(legs).toHaveLength(2);

      const [outLeg, inLeg] = legs;
      expect(outLeg.bankAccountId).toBe("sage:acc-1200");
      expect(outLeg.amount).toBe(-1500);

      expect(inLeg.bankAccountId).toBe("sage:acc-1210");
      expect(inLeg.amount).toBe(1500);
    });
  });

  describe("Canonical Validator compatibility", () => {
    it("produces records that pass validate() with zero errors", () => {
      const rawAccounts: SageLedgerAccount[] = [
        { id: "acc-1200", name: "Operating", nominal_code: 1200, ledger_account_group: { id: "BANK" } },
        { id: "acc-4000", name: "Sales", nominal_code: 4000, ledger_account_group: { id: "SALES" } },
      ];
      const rawContacts: SageContact[] = [
        { id: "con-1", name: "Customer One", contact_type_ids: ["CUSTOMER"] },
      ];
      const rawSales: SageInvoice[] = [
        {
          id: "si-1",
          invoice_number: "SI-1",
          contact: { id: "con-1" },
          date: "2026-10-10",
          status: { id: "UNPAID" },
          currency: "USD",
          total_amount: 1000,
          outstanding_amount: 1000,
          invoice_lines: [
            { description: "Licence", ledger_account: { id: "acc-4000" }, net_amount: 1000 },
          ],
        },
      ];
      const rawPurchases: SageInvoice[] = [];
      const rawBankAccounts: SageBankAccount[] = [
        { id: "bank-1", ledger_account: { id: "acc-1200" } },
      ];
      const rawTransactions: SageBankTransaction[] = [
        {
          id: "bt-1",
          date: "2026-10-12",
          amount: 500,
          currency: "USD",
          description: "Deposit",
          bank_account: { id: "bank-1" },
          bank_transaction_type: { id: "RECEIPT" },
        },
      ];

      const accounts = normalizeAccounts(rawAccounts);
      const parties = normalizeParties(rawContacts);
      const invoices = normalizeInvoices(rawSales, rawPurchases, "acc-4000", "acc-7000", "USD");
      const bankTransactions = normalizeBankTransactions(rawTransactions, rawBankAccounts, "USD");

      const result = validateFinanceSet({
        accounts,
        parties,
        invoices,
        bankTransactions,
      });

      expect(result.errors).toEqual([]);
      expect(result.set).not.toBeNull();
    });
  });
});
