import { loadDotEnv } from './env.mjs';
loadDotEnv();
import { configFromEnv, getValidAccessToken } from '../src/data/canonical/sage/token';

export async function editInvoice(newReference: string, newUnitPrice?: number) {
  const config = configFromEnv();
  const token = await getValidAccessToken(config);
  const headers = {
    Authorization: 'Bearer ' + token,
    'X-Business': config.businessId!,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  const invoiceId = '99f15f7fc0f8483198c2ff78084c857f';
  // 1. Fetch current invoice to preserve required fields
  const getRes = await fetch(`https://api.accounting.sage.com/v3.1/sales_invoices/${invoiceId}`, { headers });
  if (!getRes.ok) {
    throw new Error(`Failed to fetch invoice: HTTP ${getRes.status}`);
  }
  const curr = await getRes.json() as any;

  const line = curr.invoice_lines[0];
  const unitPrice = newUnitPrice ?? Number(line.unit_price);
  const netAmount = unitPrice * Number(line.quantity);
  const taxAmount = netAmount * 0.2; // 20% GB_STANDARD
  const totalAmount = netAmount + taxAmount;

  const payload = {
    sales_invoice: {
      contact_id: curr.contact.id,
      date: curr.date,
      due_date: curr.due_date,
      reference: newReference,
      main_address: {
        address_line_1: curr.main_address?.address_line_1 || '123 Test St',
        city: curr.main_address?.city || 'London',
        postal_code: curr.main_address?.postal_code || 'SW1A 1AA',
        country_id: 'GB'
      },
      invoice_lines: [
        {
          id: line.id,
          description: line.description,
          ledger_account_id: line.ledger_account.id,
          quantity: Number(line.quantity),
          unit_price: unitPrice,
          net_amount: netAmount,
          tax_rate_id: line.tax_rate.id,
          tax_amount: taxAmount,
          total_amount: totalAmount
        }
      ]
    }
  };

  const putRes = await fetch(`https://api.accounting.sage.com/v3.1/sales_invoices/${invoiceId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload)
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`PUT failed: HTTP ${putRes.status} ${errText}`);
  }

  const result = await putRes.json() as any;
  console.log(`Invoice updated: reference = ${result.reference}, total = ${result.total_amount}, outstanding = ${result.outstanding_amount}`);
  return result;
}

if (process.argv[1]?.endsWith('edit-invoice.ts')) {
  const ref = process.argv[2] || 'INV-TEST-001-REV1';
  const price = process.argv[3] ? Number(process.argv[3]) : undefined;
  editInvoice(ref, price).catch(console.error);
}
