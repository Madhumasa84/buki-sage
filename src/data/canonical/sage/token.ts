/**
 * OAuth token management and authorization for Sage Accounting API v3.1.
 *
 * Keeps tokens in .data/sage-tokens.json (gitignored). Handles the initial code
 * exchange, token refresh before expiry, and fetching the user's business ID.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SageOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  businessId?: string;
}

export interface SageTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in ms
  refresh_token_expires_at?: number;
  scope?: string;
  token_type?: string;
}

export interface SageBusiness {
  id: string;
  name: string;
  [key: string]: unknown;
}

export const SAGE_AUTH_URL = "https://www.sageone.com/oauth2/auth/central";
export const SAGE_TOKEN_URL = "https://oauth.accounting.sage.com/token";
export const SAGE_API_BASE = "https://api.accounting.sage.com/v3.1";

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SageOAuthConfig {
  const clientId = env.SAGE_CLIENT_ID?.trim();
  const clientSecret = env.SAGE_CLIENT_SECRET?.trim();
  const callbackUrl = env.SAGE_CALLBACK_URL?.trim() || "http://localhost:3000/api/sage/callback";
  const businessId = env.SAGE_BUSINESS_ID?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("SAGE_CLIENT_ID and SAGE_CLIENT_SECRET must be set in .env");
  }

  return { clientId, clientSecret, callbackUrl, businessId };
}

export function tokenFilePath(cwd = process.cwd()): string {
  return resolve(cwd, ".data", "sage-tokens.json");
}

export function loadTokens(cwd = process.cwd()): SageTokenData | null {
  const file = tokenFilePath(cwd);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as SageTokenData;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: SageTokenData, cwd = process.cwd()): void {
  const file = tokenFilePath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(tokens, null, 2), "utf8");
}

export function buildAuthorizeUrl(config: SageOAuthConfig, state?: string): string {
  const url = new URL(SAGE_AUTH_URL);
  url.searchParams.set("filter", "apiv3.1");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("scope", "full_access");
  url.searchParams.set("country", "gb");
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

interface RawTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function processTokenResponse(body: RawTokenResponse): SageTokenData {
  if (body.error) {
    throw new Error(`Sage token error: ${body.error} - ${body.error_description ?? "no description"}`);
  }
  if (!body.access_token || !body.refresh_token) {
    throw new Error("Sage token response did not include access_token or refresh_token");
  }

  // Deduct 30 seconds for clock skew
  const expiresInMs = Math.max(0, (body.expires_in - 30)) * 1000;
  const expires_at = Date.now() + expiresInMs;

  const refreshExpiresInMs = body.refresh_token_expires_in
    ? Math.max(0, body.refresh_token_expires_in - 60) * 1000
    : undefined;
  const refresh_token_expires_at = refreshExpiresInMs ? Date.now() + refreshExpiresInMs : undefined;

  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at,
    refresh_token_expires_at,
    scope: body.scope,
    token_type: body.token_type,
  };
}

export async function exchangeCodeForTokens(code: string, config: SageOAuthConfig, cwd = process.cwd()): Promise<SageTokenData> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch(SAGE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sage token exchange failed (HTTP ${res.status}): ${text}`);
  }

  const json = (await res.json()) as RawTokenResponse;
  const tokens = processTokenResponse(json);
  saveTokens(tokens, cwd);
  return tokens;
}

export async function refreshTokens(refreshToken: string, config: SageOAuthConfig, cwd = process.cwd()): Promise<SageTokenData> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch(SAGE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sage token refresh failed (HTTP ${res.status}): ${text}`);
  }

  const json = (await res.json()) as RawTokenResponse;
  const tokens = processTokenResponse(json);
  saveTokens(tokens, cwd);
  return tokens;
}

let refreshPromise: Promise<SageTokenData> | null = null;

export async function getValidAccessToken(config: SageOAuthConfig, cwd = process.cwd()): Promise<string> {
  const tokens = loadTokens(cwd);
  if (!tokens) {
    throw new Error("No Sage tokens found. Run `npm run sage:auth` first to authorize.");
  }

  // If still valid (with buffer), return current access_token
  if (Date.now() < tokens.expires_at) {
    return tokens.access_token;
  }

  // Deduplicate concurrent refresh calls
  if (!refreshPromise) {
    refreshPromise = refreshTokens(tokens.refresh_token, config, cwd).finally(() => {
      refreshPromise = null;
    });
  }
  const refreshed = await refreshPromise;
  return refreshed.access_token;
}

export async function fetchBusinesses(accessToken: string): Promise<SageBusiness[]> {
  const res = await fetch(`${SAGE_API_BASE}/businesses`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch Sage businesses (HTTP ${res.status}): ${text}`);
  }

  const data = (await res.json()) as { $items?: SageBusiness[] };
  return data.$items ?? [];
}
