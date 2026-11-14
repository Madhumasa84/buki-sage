import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from './env.mjs';
loadDotEnv();
import { configFromEnv, getValidAccessToken } from '../src/data/canonical/sage/token';
import { SageClient } from '../src/data/canonical/sage/client';

export async function refreshNewmanEnv(): Promise<string> {
  const config = configFromEnv();
  const token = await getValidAccessToken(config);

  const rawEnv = JSON.parse(readFileSync('test-data/SBC_Accounting_Data_Creation_postman_environment.json', 'utf8'));
  const values = rawEnv.values as Array<{ key: string; value: any; enabled: boolean }>;

  function setVal(key: string, value: any) {
    const entry = values.find(v => v.key === key);
    if (entry) {
      entry.value = value;
      entry.enabled = true;
    } else {
      values.push({ key, value, enabled: true });
    }
  }

  // Read any existing dynamic objects if already saved in .data/newman-env.json
  try {
    const existing = JSON.parse(readFileSync('.data/newman-env.json', 'utf8'));
    for (const entry of existing.values || []) {
      if (['business_data', 'ledger_data', 'bank_data', 'contact_data', 'pm_product_sales_price_types_data', 'sales_invoice_data', 'purchase_invoice_data'].includes(entry.key) && entry.value) {
        setVal(entry.key, entry.value);
      }
    }
  } catch {}

  setVal('baseurl', 'https://api.accounting.sage.com/v3.1/');
  setVal('clientId', config.clientId);
  setVal('clientSecret', config.clientSecret);
  setVal('accessToken', token);
  // Set real expiry 10 minutes in the future to keep token valid across short bursts
  setVal('accessTokenExpires', new Date(Date.now() + 10 * 60 * 1000).toISOString());
  setVal('business_id', config.businessId);

  // Read refresh token from local token store
  try {
    const tokens = JSON.parse(readFileSync('.data/sage-tokens.json', 'utf8'));
    if (tokens.refresh_token) {
      setVal('refreshToken', tokens.refresh_token);
    }
  } catch {}

  // Ensure pm_product_sales_price_types_data is populated
  const existingPriceData = values.find(v => v.key === 'pm_product_sales_price_types_data');
  if (!existingPriceData || !existingPriceData.value) {
    try {
      const client = new SageClient(config);
      const types = await client.getEnvelope<any>('/product_sales_price_types');
      const wrapped = Array.isArray(types) ? { $items: types } : types;
      setVal('pm_product_sales_price_types_data', JSON.stringify(wrapped));
    } catch {}
  }

  writeFileSync('.data/newman-env.json', JSON.stringify(rawEnv, null, 2), 'utf8');
  return token;
}

export function runNewman(folder: string, dataFile?: string): { ok: boolean; output: string } {
  let cmd = `npx --yes newman run test-data/SBC_Accounting_Data_Creation_adapted.json --folder "${folder}" -e .data/newman-env.json --export-environment .data/newman-env.json`;
  if (dataFile) {
    cmd += ` -d "${dataFile}"`;
  }

  try {
    const output = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, output };
  } catch (err: any) {
    const output = err.stdout ? String(err.stdout) : (err.message || String(err));
    return { ok: false, output };
  }
}

export async function syncInvoiceMappings() {
  const config = configFromEnv();
  const client = new SageClient(config);
  const [sales, purchases] = await Promise.all([
    client.salesInvoices(),
    client.purchaseInvoices(),
  ]);

  const salesData = sales.map(s => ({
    id: s.id,
    invoice_number: s.reference || s.invoice_number,
  }));
  const purchaseData = purchases.map(p => ({
    id: p.id,
    invoice_number: p.reference || p.invoice_number,
  }));

  const env = JSON.parse(readFileSync('.data/newman-env.json', 'utf8'));
  function setVal(key: string, value: any) {
    const entry = env.values.find((v: any) => v.key === key);
    if (entry) {
      entry.value = value;
      entry.enabled = true;
    } else {
      env.values.push({ key, value, enabled: true });
    }
  }
  setVal('sales_invoice_data', JSON.stringify(salesData));
  setVal('purchase_invoice_data', JSON.stringify(purchaseData));
  writeFileSync('.data/newman-env.json', JSON.stringify(env, null, 2), 'utf8');
  console.log(`Synced invoice mappings: ${salesData.length} sales, ${purchaseData.length} purchase invoices`);
}
