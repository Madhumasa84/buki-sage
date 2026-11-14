import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SageClient, SageError } from "./client";
import { type SageOAuthConfig } from "./token";
import * as tokenModule from "./token";

describe("SageClient Fault Handling & Failure Scenarios", () => {
  const dummyConfig: SageOAuthConfig = {
    clientId: "dummy-client-id",
    clientSecret: "dummy-client-secret",
    callbackUrl: "http://localhost:3000/api/sage/callback",
    businessId: "dummy-business-id",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tokenModule, "getValidAccessToken").mockResolvedValue("test-bearer-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws SageError('config') when SAGE_BUSINESS_ID is not configured", () => {
    const configWithoutBiz: SageOAuthConfig = {
      clientId: "dummy-client-id",
      clientSecret: "dummy-client-secret",
      callbackUrl: "http://localhost:3000/api/sage/callback",
      businessId: undefined,
    };

    expect(() => new SageClient(configWithoutBiz)).toThrowError(SageError);
    try {
      new SageClient(configWithoutBiz);
    } catch (err: any) {
      expect(err.kind).toBe("config");
      expect(err.message).toContain("SAGE_BUSINESS_ID is not set");
    }
  });

  it("throws SageError('timeout') when request exceeds timeout", async () => {
    const client = new SageClient(dummyConfig);
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";

    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutErr);

    try {
      await client.ledgerAccounts();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SageError);
      expect(err.kind).toBe("timeout");
      expect(err.message).toContain("timed out");
    }
  });

  it("throws SageError('network') when network connection fails", async () => {
    const client = new SageClient(dummyConfig);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed (getaddrinfo ENOTFOUND)"));

    try {
      await client.contacts();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SageError);
      expect(err.kind).toBe("network");
      expect(err.message).toContain("Could not reach Sage API");
    }
  });

  it("throws SageError('auth') on HTTP 401 Unauthorized or HTTP 403 Forbidden", async () => {
    const client = new SageClient(dummyConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    try {
      await client.salesInvoices();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SageError);
      expect(err.kind).toBe("auth");
      expect(err.status).toBe(401);
      expect(err.message).toContain("Sage rejected credentials or access token");
    }
  });

  it("throws SageError('http') on HTTP 5xx Server Errors or HTTP 429 Rate Limits", async () => {
    const client = new SageClient(dummyConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    try {
      await client.purchaseInvoices();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SageError);
      expect(err.kind).toBe("http");
      expect(err.status).toBe(500);
      expect(err.message).toContain("Sage answered /purchase_invoices with HTTP 500");
    }
  });

  it("throws SageError('shape') when Sage answers with invalid non-JSON", async () => {
    const client = new SageClient(dummyConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    try {
      await client.bankAccounts();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SageError);
      expect(err.kind).toBe("shape");
      expect(err.message).toContain("invalid JSON");
    }
  });

  it("throws SageError('shape') when envelope is missing the $items array", async () => {
    const client = new SageClient(dummyConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ $total: 0, items: [] }), { status: 200 }),
    );

    try {
      await client.ledgerAccounts();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SageError);
      expect(err.kind).toBe("shape");
      expect(err.message).toContain("did not contain an $items array");
    }
  });

  it("baseCurrency() throws SageError('shape') when base_currency is unresolvable", async () => {
    const client = new SageClient(dummyConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ base_currency: null }), { status: 200 }),
    );

    try {
      await client.baseCurrency();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SageError);
      expect(err.kind).toBe("shape");
      expect(err.message).toContain("Could not establish authoritative base currency");
    }
  });
});
