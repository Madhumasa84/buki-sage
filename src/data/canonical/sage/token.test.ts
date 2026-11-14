import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getValidAccessToken,
  saveTokens,
  loadTokens,
  type SageOAuthConfig,
  type SageTokenData,
  SAGE_TOKEN_URL,
} from "./token";

describe("Sage Token Management & Refresh Mutex", () => {
  let tempDir: string;
  const dummyConfig: SageOAuthConfig = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    callbackUrl: "http://localhost:3000/callback",
    businessId: "test-biz-id",
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sage-token-test-"));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("throws clear error when no tokens exist on disk", async () => {
    await expect(getValidAccessToken(dummyConfig, tempDir)).rejects.toThrow(
      "No Sage tokens found. Run `npm run sage:auth` first to authorize.",
    );
  });

  it("returns existing access token when still valid", async () => {
    const validTokens: SageTokenData = {
      access_token: "existing-valid-access-token",
      refresh_token: "existing-refresh-token",
      expires_at: Date.now() + 60_000, // Valid for 60s
      token_type: "bearer",
      scope: "full_access",
    };
    saveTokens(validTokens, tempDir);

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const token = await getValidAccessToken(dummyConfig, tempDir);
    expect(token).toBe("existing-valid-access-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent refresh calls using the refresh mutex lock", async () => {
    const expiredTokens: SageTokenData = {
      access_token: "expired-access-token",
      refresh_token: "my-refresh-token",
      expires_at: Date.now() - 1000, // Expired
      token_type: "bearer",
      scope: "full_access",
    };
    saveTokens(expiredTokens, tempDir);

    let resolveFetch: (val: any) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      if (url === SAGE_TOKEN_URL) {
        await fetchPromise;
        return new Response(
          JSON.stringify({
            access_token: "new-refreshed-token",
            refresh_token: "new-refresh-token",
            expires_in: 300,
            token_type: "bearer",
            scope: "full_access",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    // Fire 3 simultaneous token requests
    const p1 = getValidAccessToken(dummyConfig, tempDir);
    const p2 = getValidAccessToken(dummyConfig, tempDir);
    const p3 = getValidAccessToken(dummyConfig, tempDir);

    // Release the single fetch call
    resolveFetch!(true);

    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);

    expect(t1).toBe("new-refreshed-token");
    expect(t2).toBe("new-refreshed-token");
    expect(t3).toBe("new-refreshed-token");

    // fetch must be called only ONCE, preventing invalid_grant refresh collision
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Verify updated tokens were persisted to disk
    const saved = loadTokens(tempDir);
    expect(saved?.access_token).toBe("new-refreshed-token");
    expect(saved?.refresh_token).toBe("new-refresh-token");
  });

  it("handles HTTP failure during token refresh", async () => {
    const expiredTokens: SageTokenData = {
      access_token: "expired-access-token",
      refresh_token: "bad-refresh-token",
      expires_at: Date.now() - 1000,
      token_type: "bearer",
      scope: "full_access",
    };
    saveTokens(expiredTokens, tempDir);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    await expect(getValidAccessToken(dummyConfig, tempDir)).rejects.toThrow(
      /Sage token refresh failed \(HTTP 400\)/,
    );
  });
});
