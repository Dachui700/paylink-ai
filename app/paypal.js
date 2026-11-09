/**
 * PayPal Sandbox Client (Invoicing API v2)
 *
 * Handles OAuth2 client-credentials authentication, invoice generation,
 * shareable payment link creation, and invoice status queries.
 * Automatically falls back to MOCK MODE when sandbox credentials are not configured.
 */

const crypto = require('crypto');

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

// In-memory mock database for simulated invoices
const mockInvoices = new Map();

// Token cache for real sandbox mode
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Checks if the app is running in Mock Mode (no valid PayPal credentials configured).
 */
function isMockMode() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) return true;
  if (clientId.trim() === '' || clientSecret.trim() === '') return true;
  if (clientId === 'your_sandbox_client_id_here' || clientSecret === 'your_sandbox_client_secret_here') return true;

  return false;
}

/**
 * Obtain OAuth2 Access Token via Client Credentials Grant
 * Endpoint: POST https://api-m.sandbox.paypal.com/v1/oauth2/token
 */
async function getAccessToken() {
  if (isMockMode()) {
    return 'MOCK_BEARER_TOKEN';
  }

  // Check token cache (refresh 60s before expiration)
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  const clientId = process.env.PAYPAL_CLIENT_ID.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET.trim();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PayPal OAuth2 Error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in * 1000);
  return cachedToken;
}

/**
 * Create a PayPal Invoice and obtain a shareable payment link.
 * API Flow:
 *  1. POST /v2/invoicing/invoices (Create draft invoice)
 *  2. POST /v2/invoicing/invoices/{invoice_id}/send with send_to_recipient: false (Generate shareable link)
 */
async function createInvoiceLink({ customer, amount, currency = 'USD', item = 'Goods', note = '' }) {
  const numericAmount = parseFloat(amount) || 10.00;
  const safeCurrency = currency.toUpperCase() === 'CNY' ? 'USD' : currency.toUpperCase(); // Sandbox note: PayPal sandbox accounts standardly invoice in USD/EUR/GBP
  const originalCurrency = currency.toUpperCase();

  if (isMockMode()) {
    // Generate realistic simulated PayPal invoice
    const randomHex = crypto.randomBytes(6).toString('hex').toUpperCase();
    const invoiceId = `INV2-MOCK-${randomHex}`;
    const paymentUrl = `https://www.sandbox.paypal.com/invoice/p/#${invoiceId}`;
    const invoiceRecord = {
      invoiceId,
      paymentUrl,
      status: 'SENT', // UNPAID
      customer: customer || '客户 / Customer',
      amount: numericAmount,
      currency: originalCurrency,
      item: item || '商品 / Goods',
      note: note || '感谢您的支持！Thank you for your business!',
      createdAt: new Date().toISOString(),
      isMock: true
    };
    mockInvoices.set(invoiceId, invoiceRecord);
    return invoiceRecord;
  }

  // --- Real PayPal Sandbox API Call ---
  const token = await getAccessToken();

  // Step 1: Create draft invoice
  const invoicePayload = {
    detail: {
      currency_code: safeCurrency,
      note: note || `Payment link for ${customer}: ${item}`,
      payment_term: {
        term_type: 'DUE_ON_RECEIPT'
      }
    },
    invoicer: {
      business_name: 'Small Seller Store'
    },
    primary_recipients: [
      {
        billing_info: {
          name: {
            given_name: customer || 'Customer'
          }
        }
      }
    ],
    items: [
      {
        name: item || 'Item or Service',
        quantity: '1',
        unit_amount: {
          currency_code: safeCurrency,
          value: numericAmount.toFixed(2)
        }
      }
    ]
  };

  const createRes = await fetch(`${PAYPAL_API_BASE}/v2/invoicing/invoices`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(invoicePayload)
  });

  if (!createRes.ok) {
    const errorText = await createRes.text();
    throw new Error(`PayPal Create Invoice Error (${createRes.status}): ${errorText}`);
  }

  const invoiceData = await createRes.json();
  const invoiceId = invoiceData.id;

  // Step 2: Send invoice with send_to_recipient: false to activate & get share link
  const sendRes = await fetch(`${PAYPAL_API_BASE}/v2/invoicing/invoices/${invoiceId}/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ send_to_recipient: false })
  });

  let paymentUrl = `https://www.sandbox.paypal.com/invoice/p/#${invoiceId}`;
  if (sendRes.ok) {
    const sendData = await sendRes.json();
    if (sendData.href) {
      paymentUrl = sendData.href;
    }
  }

  return {
    invoiceId,
    paymentUrl,
    status: 'SENT',
    customer,
    amount: numericAmount,
    currency: safeCurrency,
    item,
    note,
    createdAt: new Date().toISOString(),
    isMock: false
  };
}

/**
 * Query invoice status
 * Real: GET https://api-m.sandbox.paypal.com/v2/invoicing/invoices/{invoice_id}
 * Mock: checks in-memory store
 */
async function getInvoiceStatus(invoiceId) {
  if (isMockMode()) {
    const record = mockInvoices.get(invoiceId);
    if (!record) {
      return { invoiceId, status: 'NOT_FOUND', isMock: true };
    }
    return {
      invoiceId,
      status: record.status,
      paidAt: record.paidAt || null,
      isMock: true
    };
  }

  // --- Real PayPal Sandbox API Call ---
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/invoicing/invoices/${invoiceId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PayPal Get Status Error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    invoiceId: data.id,
    status: data.status, // 'SENT', 'PAID', 'MARKED_AS_PAID', 'DRAFT', etc.
    isMock: false,
    raw: data
  };
}

/**
 * Mock mode only: simulate that the buyer has paid the invoice.
 */
function simulatePaid(invoiceId) {
  const record = mockInvoices.get(invoiceId);
  if (!record) {
    // If not found in mockInvoices, still create a paid entry
    const newRecord = {
      invoiceId,
      status: 'PAID',
      paidAt: new Date().toISOString(),
      isMock: true
    };
    mockInvoices.set(invoiceId, newRecord);
    return newRecord;
  }
  record.status = 'PAID';
  record.paidAt = new Date().toISOString();
  return record;
}

module.exports = {
  isMockMode,
  getAccessToken,
  createInvoiceLink,
  getInvoiceStatus,
  simulatePaid,
  mockInvoices
};
