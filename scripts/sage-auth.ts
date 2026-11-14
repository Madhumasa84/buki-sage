#!/usr/bin/env tsx
/**
 * One-time OAuth authorization helper for Sage Accounting.
 *
 * Supports two modes:
 * 1. Automatic: Listens on the port in SAGE_CALLBACK_URL (default 3000), captures redirect,
 *    exchanges code, discovers business ID, and updates .env.
 * 2. Direct: If invoked with `--code <code-or-redirect-url>`, exchanges the code immediately
 *    without needing a browser redirect to reach localhost.
 */

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv } from "./env.mjs";
import {
  buildAuthorizeUrl,
  configFromEnv,
  exchangeCodeForTokens,
  fetchBusinesses,
  type SageOAuthConfig,
} from "../src/data/canonical/sage/token";

loadDotEnv();

function updateDotEnv(businessId: string) {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  let text = readFileSync(envPath, "utf8");

  // Update SAGE_BUSINESS_ID
  if (text.includes("SAGE_BUSINESS_ID=")) {
    text = text.replace(/SAGE_BUSINESS_ID=.*(?:\r?\n|$)/, `SAGE_BUSINESS_ID="${businessId}"\n`);
  } else {
    text += `\nSAGE_BUSINESS_ID="${businessId}"\n`;
  }

  // Set FINANCE_SOURCE=sage
  if (text.includes("FINANCE_SOURCE=")) {
    text = text.replace(/FINANCE_SOURCE=.*(?:\r?\n|$)/, `FINANCE_SOURCE=sage\n`);
  } else {
    text += `\nFINANCE_SOURCE=sage\n`;
  }

  writeFileSync(envPath, text, "utf8");
}

async function handleCode(code: string, config: SageOAuthConfig): Promise<string> {
  console.log("\nReceived authorization code. Exchanging for tokens...");
  const tokens = await exchangeCodeForTokens(code, config);
  console.log("✓ Tokens successfully obtained and stored in .data/sage-tokens.json");

  console.log("Discovering businesses linked to this Sage account...");
  const businesses = await fetchBusinesses(tokens.access_token);

  let businessId = "";
  let businessName = "Sage Trial Business";

  if (businesses.length > 0) {
    const b = businesses[0];
    businessId = b.id;
    businessName = b.name || "Default Business";
    console.log(`\nFound ${businesses.length} business(es):`);
    for (const item of businesses) {
      console.log(`  - ${item.name} (ID: ${item.id})`);
    }
    console.log(`Selected: ${businessName} (${businessId})`);
    updateDotEnv(businessId);
    console.log(`✓ Updated .env: SAGE_BUSINESS_ID="${businessId}" and FINANCE_SOURCE=sage`);
  } else {
    console.warn("\n⚠️ No businesses found in Sage account. Make sure your trial business is set up.");
  }

  return businessName;
}

async function main() {
  const config = configFromEnv();

  // Check if code was passed directly via CLI arguments
  const args = process.argv.slice(2);
  let directInput: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--code" && args[i + 1]) {
      directInput = args[i + 1];
      break;
    } else if (args[i].startsWith("http://") || args[i].startsWith("https://")) {
      directInput = args[i];
      break;
    }
  }

  if (directInput) {
    let code = directInput;
    if (directInput.startsWith("http")) {
      try {
        const u = new URL(directInput);
        code = u.searchParams.get("code") ?? directInput;
      } catch {
        code = directInput;
      }
    }
    await handleCode(code, config);
    console.log("\n🎉 Sage OAuth setup complete! You can now run `npm run sync`.");
    process.exit(0);
  }

  const callbackUrl = new URL(config.callbackUrl);
  const port = Number(callbackUrl.port) || 3000;
  const expectedPath = callbackUrl.pathname || "/api/sage/callback";

  // Use a fixed or persistent session state for the run
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = buildAuthorizeUrl(config, state);

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);

      // Ignore favicon or non-callback requests
      if (reqUrl.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (reqUrl.pathname !== expectedPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");
      const error = reqUrl.searchParams.get("error");
      const errorDesc = reqUrl.searchParams.get("error_description");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Sage Authorization Error</h1><p>${error}: ${errorDesc ?? "Unknown error"}</p>`);
        console.error(`\n❌ Authorization error from Sage: ${error} (${errorDesc})`);
        return;
      }

      if (returnedState && returnedState !== state) {
        console.warn(`\n⚠️ State mismatch (received ${returnedState}, expected ${state})`);
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Missing Code</h1><p>No authorization code received in callback URL.</p>`);
        console.warn("\n⚠️ Received callback without a code parameter.");
        return;
      }

      const businessName = await handleCode(code, config);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Sage Authorization Succeeded</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; color: #1e293b; }
            .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); max-width: 480px; text-align: center; }
            h1 { color: #16a34a; font-size: 24px; margin-bottom: 12px; }
            p { color: #64748b; font-size: 15px; line-height: 1.5; }
            code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #0f172a; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>✓ Sage Connected!</h1>
            <p>Authorization complete for <b>${businessName}</b>.</p>
            <p>Tokens saved to <code>.data/sage-tokens.json</code> and business ID saved to <code>.env</code>.</p>
            <p>You can close this window and return to your terminal.</p>
          </div>
        </body>
        </html>
      `);

      server.close(() => {
        console.log("\n🎉 Sage OAuth setup complete! You can now run `npm run sync`.");
        process.exit(0);
      });
    } catch (err) {
      console.error("\n❌ Error handling callback:", err);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>Internal Error</h1><p>${err instanceof Error ? err.message : String(err)}</p>`);
    }
  });

  server.listen(port, () => {
    console.log("====================================================================");
    console.log("              Buki Sage Connector OAuth Setup                      ");
    console.log("====================================================================");
    console.log(`\nLocal callback listener active at: http://localhost:${port}${expectedPath}`);
    console.log("\n👉 Please open the following URL in your browser to sign in to Sage:");
    console.log(`\n${authUrl}\n`);
    console.log("====================================================================");
    console.log("Waiting for authorization callback (Ctrl+C to cancel)...");
  });
}

main().catch((err) => {
  console.error("Fatal error starting auth script:", err);
  process.exit(1);
});
