/**
 * Small Seller Payment Assistant (小卖家收款助手)
 * Server Entry Point
 *
 * Plain Node.js + Express. Zero extra external dependencies.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

// --- Load .env if present (Vanilla Node, no dotenv dependency required) ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    });
  } catch (e) {
    console.warn('Notice: Could not load .env file:', e.message);
  }
}

const { parseRequest } = require('./parse');
const paypal = require('./paypal');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for created payment links
// Maps id -> { id, invoiceId, customer, amount, currency, item, paymentUrl, status, reminderCount, createdAt, updatedAt }
const paymentLinks = new Map();

/**
 * GET /api/config
 * Returns system configuration state (e.g. mock mode status)
 */
app.get('/api/config', (req, res) => {
  res.json({
    mockMode: paypal.isMockMode(),
    port: PORT,
    paypalApiBase: process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    clientIdConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_ID !== 'your_sandbox_client_id_here')
  });
});

/**
 * POST /api/links
 * Creates a payment link from natural language text or structured fields.
 * Request body: { text: "给客户 A 发 50 美元的付款链接，卖的是手工皮包" }
 * or { customer, amount, currency, item, note }
 */
app.post('/api/links', async (req, res) => {
  try {
    const { text, customer: reqCustomer, amount: reqAmount, currency: reqCurrency, item: reqItem, note } = req.body;

    let parsed = null;
    let customer = reqCustomer;
    let amount = reqAmount;
    let currency = reqCurrency;
    let item = reqItem;

    if (text) {
      parsed = await parseRequest(text);
      customer = customer || parsed.customer;
      amount = amount || parsed.amount;
      currency = currency || parsed.currency;
      item = item || parsed.item;
    }

    if (!amount || isNaN(parseFloat(amount))) {
      return res.status(400).json({
        error: 'Missing or invalid amount. Amount must be a positive number.'
      });
    }

    // Call PayPal Sandbox API (or Mock Mode)
    const invoice = await paypal.createInvoiceLink({
      customer: customer || '客户 / Customer',
      amount: parseFloat(amount),
      currency: (currency || 'USD').toUpperCase(),
      item: item || '商品 / Goods',
      note: note || ''
    });

    const linkId = invoice.invoiceId;
    const record = {
      id: linkId,
      invoiceId: invoice.invoiceId,
      customer: invoice.customer,
      amount: invoice.amount,
      currency: invoice.currency,
      item: invoice.item,
      note: invoice.note,
      paymentUrl: invoice.paymentUrl,
      status: invoice.status || 'SENT',
      reminderCount: 0,
      createdAt: invoice.createdAt,
      updatedAt: invoice.createdAt,
      isMock: invoice.isMock,
      parsed: parsed || null
    };

    paymentLinks.set(linkId, record);

    res.status(201).json({
      success: true,
      link: record,
      parsedInfo: parsed
    });
  } catch (err) {
    console.error('Error creating payment link:', err);
    res.status(500).json({
      error: 'Failed to create payment link: ' + err.message
    });
  }
});

/**
 * GET /api/links
 * Lists all created payment links (newest first).
 */
app.get('/api/links', (req, res) => {
  const list = Array.from(paymentLinks.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({
    links: list,
    total: list.length,
    mockMode: paypal.isMockMode()
  });
});

/**
 * GET /api/links/:id/status
 * Queries real-time payment status from PayPal Sandbox (or mock store).
 */
app.get('/api/links/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const record = paymentLinks.get(id);

    if (!record) {
      return res.status(404).json({ error: `Payment link ${id} not found` });
    }

    const statusResult = await paypal.getInvoiceStatus(record.invoiceId);
    record.status = statusResult.status;
    record.updatedAt = new Date().toISOString();
    if (statusResult.status === 'PAID') {
      record.paidAt = statusResult.paidAt || record.paidAt || new Date().toISOString();
    }

    paymentLinks.set(id, record);

    res.json({
      id: record.id,
      invoiceId: record.invoiceId,
      status: record.status,
      isPaid: record.status === 'PAID',
      paidAt: record.paidAt || null,
      isMock: statusResult.isMock,
      link: record
    });
  } catch (err) {
    console.error(`Error querying status for ${req.params.id}:`, err);
    res.status(500).json({ error: 'Failed to query status: ' + err.message });
  }
});

/**
 * POST /api/links/:id/simulate-paid
 * Mock mode demo helper: flips payment status to PAID without needing real sandbox transaction.
 */
app.post('/api/links/:id/simulate-paid', (req, res) => {
  const { id } = req.params;
  const record = paymentLinks.get(id);

  if (!record) {
    return res.status(404).json({ error: `Payment link ${id} not found` });
  }

  const updatedMock = paypal.simulatePaid(record.invoiceId);
  record.status = 'PAID';
  record.paidAt = updatedMock.paidAt || new Date().toISOString();
  record.updatedAt = new Date().toISOString();
  paymentLinks.set(id, record);

  res.json({
    success: true,
    message: 'Simulated payment completed successfully! Status updated to PAID.',
    link: record
  });
});

/**
 * POST /api/links/:id/remind
 * Returns a drafted polite reminder message (Chinese & English) for the seller to send.
 * NOTE: Does NOT send any real email/SMS — purely generates the draft copy.
 */
app.post('/api/links/:id/remind', (req, res) => {
  const { id } = req.params;
  const record = paymentLinks.get(id);

  if (!record) {
    return res.status(404).json({ error: `Payment link ${id} not found` });
  }

  record.reminderCount = (record.reminderCount || 0) + 1;
  record.lastRemindedAt = new Date().toISOString();
  paymentLinks.set(id, record);

  const customerName = record.customer || '客户';
  const itemName = record.item || '订单商品';
  const formattedAmount = `${record.currency} ${record.amount.toFixed(2)}`;

  // Draft polite reminder in Chinese
  const reminderTextZh =
    `您好【${customerName}】，这是关于【${itemName}】（金额：${formattedAmount}）的付款提醒。\n` +
    `您可以点击此 PayPal 官方安全链接直接完成付款：\n` +
    `${record.paymentUrl}\n` +
    `如果您已完成付款，请忽略此条消息，感谢您的支持！`;

  // Draft polite reminder in English
  const reminderTextEn =
    `Hi ${customerName}, friendly reminder regarding your invoice for "${itemName}" (${formattedAmount}).\n` +
    `You can review and pay securely via PayPal here:\n` +
    `${record.paymentUrl}\n` +
    `If you have already submitted payment, please disregard this note. Thank you for your business!`;

  res.json({
    id: record.id,
    status: record.status,
    isPaid: record.status === 'PAID',
    reminderCount: record.reminderCount,
    reminderText: reminderTextZh,
    reminderTextEn: reminderTextEn,
    note: 'Reminder drafted successfully. No external message was sent.',
    link: record
  });
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 小卖家收款助手 (Small Seller Payment Assistant) running`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`🔧 Mode: ${paypal.isMockMode() ? '⚠️ MOCK MODE (No PayPal credentials detected)' : '🟢 LIVE PAYPAL SANDBOX'}`);
    console.log(`=======================================================`);
  });
}

module.exports = app;
