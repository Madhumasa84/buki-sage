import { loadDotEnv } from './env.mjs';
loadDotEnv();
import { configFromEnv, getValidAccessToken } from '../src/data/canonical/sage/token';

async function main() {
  const config = configFromEnv();
  const token = await getValidAccessToken(config);
  const headers = { Authorization: 'Bearer ' + token, 'X-Business': config.businessId!, Accept: 'application/json' };

  const endpoints = [
    'contacts',
    'sales_invoices',
    'purchase_invoices',
    'sales_credit_notes',
    'purchase_credit_notes',
    'bank_accounts',
    'transactions',
    'journals'
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(`https://api.accounting.sage.com/v3.1/${ep}?items_per_page=1`, { headers });
      if (!res.ok) {
        console.log(`${ep}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as any;
      console.log(`${ep}: total = ${data['$total']}, items_per_page = ${data['$itemsPerPage']}`);
    } catch (err: any) {
      console.log(`${ep}: error ${err.message}`);
    }
  }
}

main().catch(console.error);
