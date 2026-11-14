/**
 * The Sage Accounting HTTP client (v3.1).
 *
 * Handles OAuth bearer token retrieval & refresh, business header, pagination,
 * timeouts, and typed errors. Returns raw API shapes and nothing else.
 */

import type {
  SageBankAccount,
  SageBankTransaction,
  SageBankTransfer,
  SageContact,
  SageContactPayment,
  SageEnvelope,
  SageFinancialSettings,
  SageInvoice,
  SageLedgerAccount,
  SageOtherPayment,
} from "./raw/types";
import {
  configFromEnv,
  getValidAccessToken,
  SAGE_API_BASE,
  type SageOAuthConfig,
} from "./token";

export type SageErrorKind = "config" | "auth" | "http" | "network" | "timeout" | "shape";

export class SageError extends Error {
  constructor(
    public readonly kind: SageErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SageError";
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const ITEMS_PER_PAGE = 100;

export class SageClient {
  constructor(
    private readonly config: SageOAuthConfig = configFromEnv(),
    private readonly cwd = process.cwd(),
  ) {
    if (!this.config.businessId) {
      throw new SageError(
        "config",
        "SAGE_BUSINESS_ID is not set in .env. Run `npm run sage:auth` to select your business.",
      );
    }
  }

  private async fetchWithAuth(url: string): Promise<Response> {
    const token = await getValidAccessToken(this.config, this.cwd);

    try {
      return await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Business": this.config.businessId!,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new SageError("timeout", `Sage API request to ${url} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw new SageError("network", `Could not reach Sage API: ${describe(err)}`);
    }
  }

  private async getEnvelope<T>(path: string, query?: Record<string, string>): Promise<T[]> {
    let currentUrl: string | null;
    const initialUrl = new URL(`${SAGE_API_BASE}${path}`);
    initialUrl.searchParams.set("items_per_page", String(ITEMS_PER_PAGE));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") {
          initialUrl.searchParams.set(k, v);
        }
      }
    }
    currentUrl = initialUrl.toString();

    const items: T[] = [];

    while (currentUrl) {
      const res = await this.fetchWithAuth(currentUrl);

      if (res.status === 401 || res.status === 403) {
        throw new SageError("auth", `Sage rejected credentials or access token for ${path}`, res.status);
      }
      if (!res.ok) {
        throw new SageError("http", `Sage answered ${path} with HTTP ${res.status}`, res.status);
      }

      let envelope: SageEnvelope<T>;
      try {
        envelope = (await res.json()) as SageEnvelope<T>;
      } catch {
        throw new SageError("shape", `Sage answered ${path} with invalid JSON`);
      }

      if (!envelope || !Array.isArray(envelope.$items)) {
        throw new SageError("shape", `Sage envelope for ${path} did not contain an $items array`);
      }

      items.push(...envelope.$items);

      if (envelope.$next) {
        currentUrl = envelope.$next.startsWith("http")
          ? envelope.$next
          : `${SAGE_API_BASE}${envelope.$next}`;
      } else {
        currentUrl = null;
      }
    }

    return items;
  }

  /**
   * Reads authoritative financial settings from Sage, including base currency.
   */
  async financialSettings(): Promise<SageFinancialSettings> {
    const res = await this.fetchWithAuth(`${SAGE_API_BASE}/financial_settings`);
    if (res.status === 401 || res.status === 403) {
      throw new SageError("auth", "Sage rejected credentials for /financial_settings", res.status);
    }
    if (!res.ok) {
      throw new SageError("http", `Sage answered /financial_settings with HTTP ${res.status}`, res.status);
    }
    try {
      return (await res.json()) as SageFinancialSettings;
    } catch {
      throw new SageError("shape", "Sage returned invalid JSON for /financial_settings");
    }
  }

  /**
   * Retrieves the authoritative business base currency code (e.g. "GBP").
   * Fails clearly if currency cannot be established.
   */
  async baseCurrency(): Promise<string> {
    const settings = await this.financialSettings();
    const code = settings.base_currency?.id?.trim().toUpperCase();
    if (code && /^[A-Z]{3}$/.test(code)) {
      return code;
    }
    throw new SageError(
      "shape",
      `Could not establish authoritative base currency from Sage /financial_settings (got: ${JSON.stringify(settings.base_currency)})`,
    );
  }

  async ledgerAccounts(): Promise<SageLedgerAccount[]> {
    return this.getEnvelope<SageLedgerAccount>("/ledger_accounts", { attributes: "all" });
  }

  async bankAccounts(): Promise<SageBankAccount[]> {
    return this.getEnvelope<SageBankAccount>("/bank_accounts", { attributes: "all" });
  }

  async contacts(): Promise<SageContact[]> {
    return this.getEnvelope<SageContact>("/contacts", { attributes: "all" });
  }

  async salesInvoices(since?: string): Promise<SageInvoice[]> {
    const query: Record<string, string> = { attributes: "all" };
    if (since) query.updated_or_created_since = since;
    return this.getEnvelope<SageInvoice>("/sales_invoices", query);
  }

  async purchaseInvoices(since?: string): Promise<SageInvoice[]> {
    const query: Record<string, string> = { attributes: "all" };
    if (since) query.updated_or_created_since = since;
    return this.getEnvelope<SageInvoice>("/purchase_invoices", query);
  }

  async otherPayments(since?: string): Promise<SageOtherPayment[]> {
    const query: Record<string, string> = { attributes: "all" };
    if (since) query.updated_or_created_since = since;
    return this.getEnvelope<SageOtherPayment>("/other_payments", query);
  }

  async contactPayments(since?: string): Promise<SageContactPayment[]> {
    const query: Record<string, string> = { attributes: "all" };
    if (since) query.updated_or_created_since = since;
    return this.getEnvelope<SageContactPayment>("/contact_payments", query);
  }

  async bankTransfers(since?: string): Promise<SageBankTransfer[]> {
    const query: Record<string, string> = { attributes: "all" };
    if (since) query.updated_or_created_since = since;
    return this.getEnvelope<SageBankTransfer>("/bank_transfers", query);
  }
}

export function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
  }
  return String(err);
}
