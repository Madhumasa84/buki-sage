import { readFileSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from './env.mjs';
loadDotEnv();
import { configFromEnv, getValidAccessToken } from '../src/data/canonical/sage/token';

async function main() {
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

  setVal('baseurl', 'https://api.accounting.sage.com/v3.1/');
  setVal('clientId', config.clientId);
  setVal('clientSecret', config.clientSecret);
  setVal('accessToken', token);
  setVal('accessTokenExpires', '2099-01-01T00:00:00Z');
  setVal('business_id', config.businessId);

  writeFileSync('.data/newman-env.json', JSON.stringify(rawEnv, null, 2), 'utf8');
  console.log('Prepared .data/newman-env.json successfully');
}

main().catch(console.error);
