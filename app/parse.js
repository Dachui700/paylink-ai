/**
 * Natural Language Parser for Small Seller Payment Requests
 * Extracts: customer, amount, currency, and item description.
 * Supports Chinese and English input strings.
 */

/**
 * =========================================================================
 * LLM INTEGRATION HOOK
 * =========================================================================
 * To plug in an LLM (e.g. OpenAI, Anthropic Claude, or Google Gemini):
 * 1. Configure the LLM client with your API key.
 * 2. Send the system prompt asking for JSON output: { customer, amount, currency, item }.
 * 3. Return the parsed object.
 *
 * NOTE: Currently returns null so the app uses the built-in regex rule parser
 * without requiring any external LLM API key or network call.
 */
async function parseWithLLM(text) {
  // --- LLM STUB ---
  // Example future implementation:
  //
  // const prompt = `Extract payment details as JSON from this text:
  // Text: "${text}"
  // Schema: { "customer": string, "amount": number, "currency": "USD"|"CNY"|"EUR"|"GBP", "item": string }`;
  // const completion = await aiClient.chat({ messages: [{ role: 'user', content: prompt }] });
  // return JSON.parse(completion.text);
  //
  return null; // Fallback to rule-based parser
}

/**
 * Rule-based fallback parser for demo and local usage.
 * Handles common Chinese and English phrasing patterns.
 */
function parseWithRules(text) {
  const raw = (text || '').trim();
  if (!raw) {
    return {
      customer: '客户 / Customer',
      amount: 10.00,
      currency: 'USD',
      item: '商品 / Goods',
      confidence: 0,
      rawText: ''
    };
  }

  // 1. Detect Currency (Important: Check USD/美元/美金 BEFORE CNY/元 so '美元' isn't matched by '元')
  let currency = 'USD'; // default
  if (/美元|美金|usd|\$|dollars?|bucks/i.test(raw)) {
    currency = 'USD';
  } else if (/人民币|cny|rmb|元|块|￥|¥/i.test(raw)) {
    currency = 'CNY';
  } else if (/欧元|eur|€/i.test(raw)) {
    currency = 'EUR';
  } else if (/英镑|gbp|£/i.test(raw)) {
    currency = 'GBP';
  }

  // 2. Extract Amount
  let amount = 10.00;
  const amountPatterns = [
    /[$￥¥€£]\s*(\d+(?:\.\d{1,2})?)/,
    /(\d+(?:\.\d{1,2})?)\s*(?:美元|美金|usd|人民币|cny|rmb|元|块|欧元|eur|英镑|gbp|dollars?|bucks)/i,
    /\b(\d+(?:\.\d{1,2})?)\b/
  ];

  for (const pattern of amountPatterns) {
    const match = raw.match(pattern);
    if (match && match[1]) {
      const parsedNum = parseFloat(match[1]);
      if (!isNaN(parsedNum) && parsedNum > 0) {
        amount = parsedNum;
        break;
      }
    }
  }

  // 3. Extract Customer Name
  let customer = '';
  // Case A: English invoice for Bob for coffee beans / send link to Alice for bag
  const enInvoiceForMatch = raw.match(/(?:invoice|link|bill)\s+for\s+([A-Za-z0-9_\u4e00-\u9fa5]+)\s+for\s+(.+)/i);
  if (enInvoiceForMatch) {
    customer = enInvoiceForMatch[1].trim();
  } else {
    const customerPatterns = [
      // Chinese: 给客户 A 发..., 给客户A发...
      /给\s*客户\s*([A-Za-z0-9_\u4e00-\u9fa5]{1,12})\s*(?:发|开|建|收|要|催|做|提)/i,
      // Chinese: 给张三发...
      /给\s*([A-Za-z0-9_\u4e00-\u9fa5]{1,10})\s*(?:发|开|建|收|要|催|做|提)/i,
      // Chinese: 向客户李四收款 / 向王总收款...
      /向\s*客户\s*([A-Za-z0-9_\u4e00-\u9fa5]{1,12})\s*(?:收|要|开|发|索取)/i,
      /向\s*([A-Za-z0-9_\u4e00-\u9fa5]{1,10})\s*(?:收|要|开|发|索取)/i,
      // Chinese: 客户: 张三 / 买家: Alice
      /(?:客户|买家|客户名|付款人)\s*[:：]?\s*([A-Za-z0-9_\u4e00-\u9fa5]{1,12})/i,
      // English: to Alice for..., bill Bob 50..., send Charlie...
      /(?:to|bill)\s+(?:customer\s+|client\s+)?([A-Za-z0-9_]{2,20})(?:\s+for|\s+of|\s*[,;]|\s+a\b|\s+an\b|\s+\$|\s+\d|$)/i,
      /customer\s*[:：]\s*([A-Za-z0-9_]{2,20})/i
    ];

    for (const pattern of customerPatterns) {
      const match = raw.match(pattern);
      if (match && match[1]) {
        const cand = match[1].trim();
        // If it explicitly matched "客户 A" or "买家 A", allow single letter A/B/C/etc.
        const isClientPrefix = /客户|买家/i.test(match[0]);
        if (isClientPrefix) {
          customer = cand.length === 1 ? `客户 ${cand.toUpperCase()}` : cand;
          break;
        }

        if (!['一个', '一份', '链接', '账单', '付款', 'a', 'an', 'the', 'payment'].includes(cand.toLowerCase())) {
          customer = cand;
          break;
        }
      }
    }
  }

  // Prettify Chinese single-letter customer name e.g. "A" -> "客户 A" if originally had "客户 A"
  if (/客户\s*[A-Za-z]\b/i.test(raw) && customer.length === 1) {
    customer = `客户 ${customer.toUpperCase()}`;
  }

  if (!customer) {
    customer = '客户 / Customer';
  }

  // 4. Extract Item Description
  let item = '';
  if (enInvoiceForMatch && enInvoiceForMatch[2]) {
    item = enInvoiceForMatch[2].replace(/[.,;!]$/, '').trim();
  }

  if (!item) {
    const itemPatterns = [
      // Chinese: 卖的是手工皮包, 买的是...
      /(?:卖的是|买的是|内容是|品名是|产品是|项目是|服务是|购买|备注[是为]?)\s*[:：]?\s*([^,，。!！\n]+)/i,
      // Chinese: 给张三发一个 120 块的手工定制钱包链接 -> 手工定制钱包
      /(?:发|开|做)?(?:一个|一份|一双|一件|一部|一款|单|套)\s*(?:(?:\d+(?:\.\d+)?\s*(?:块|元|美元|美金|usd|rmb|cny))(?:\s*的)?)?\s*([^,，。!！\n]+?)(?:的)?(?:付款链接|链接|账单)/i,
      // Chinese: 向王总收款 500 人民币 网页设计定金 -> 网页设计定金
      /(?:(?:美元|美金|usd|人民币|cny|rmb|元|块)\s*)([^\s,，。!！\n]+(?:定金|设计|服务|咨询|产品|手作|包|费|款|品))/i,
      // Chinese: 末尾单独的词组：如 ... 500 人民币 网页设计定金 / 咨询费
      /(?:[,，\s])\s*([^,，。!！\n\s]{2,15}(?:定金|服务|咨询|设计|手工|包|费|款|茶叶|咖啡|蛋糕|课程))(?=[,，。!！\n]|$)/i,
      // English: for handmade leather bag
      /(?:for|item|product|service|regarding)\s*[:：]?\s*(?:a\s+|an\s+|the\s+)?([^,.;\n]+)/i
    ];

    for (const pattern of itemPatterns) {
      const match = raw.match(pattern);
      if (match && match[1]) {
        const cand = match[1].trim();
        const cleaned = cand.replace(/(?:的付款链接|付款链接|账单|链接)$/, '').trim();
        if (cleaned.length > 0) {
          item = cleaned;
          break;
        }
      }
    }
  }

  // If item is still empty, look after comma or space
  if (!item) {
    const segments = raw.split(/[，,\n]/).map(s => s.trim()).filter(Boolean);
    if (segments.length > 1) {
      const last = segments[segments.length - 1];
      if (!last.includes('链接') && !last.includes('发') && last.length <= 20) {
        item = last.replace(/^(卖的是|买的是|是|用于)/, '').trim();
      }
    }
  }

  if (!item) {
    item = '商品 / Goods';
  }

  return {
    customer,
    amount,
    currency,
    item,
    confidence: 0.95,
    rawText: raw
  };
}

/**
 * Main parse entry point: tries LLM first, gracefully falls back to rule-based engine.
 */
async function parseRequest(text) {
  try {
    const llmResult = await parseWithLLM(text);
    if (llmResult && llmResult.amount) {
      return { ...llmResult, parsedBy: 'llm', rawText: text };
    }
  } catch (err) {
    // LLM failed or not configured, continue to rule-based parser
  }

  const ruleResult = parseWithRules(text);
  return { ...ruleResult, parsedBy: 'rules' };
}

module.exports = {
  parseRequest,
  parseWithRules,
  parseWithLLM
};
