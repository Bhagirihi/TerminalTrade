'use strict';

const { config } = require('./config');

const MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];

function redact(text) {
  return String(text || '').replace(/AIza[0-9A-Za-z_-]{10,}/g, '[key]');
}

function briefRows(rows) {
  return rows
    .map((row) => {
      const pnl = row.pnlPct == null ? '' : row.pnlPct;
      return [
        row.ticker,
        `qty ${row.quantity}`,
        `buy ${row.buyPrice}`,
        `last ${row.currentPrice}`,
        `pnl% ${pnl}`,
        `sma50 ${row.sma50}`,
        `rsi ${row.rsi}`,
        row.action,
      ].join(' | ');
    })
    .join('\n');
}

function promptFor(rows, whenLabel) {
  return [
    'Review this delivery book. Use only the rows below. Do not invent prices.',
    `Snapshot: ${whenLabel}. If that clock is outside the cash session, these are last traded prices.`,
    'Labels already applied from a 50-day average and a 14-session simple RSI:',
    '- SELL / CUT LOSS: last price is under the 50-day average and the loss is worse than 10%.',
    '- BOOK PROFIT / REVIEW: RSI is above 75 and the other rules did not fire. The position can still be a loss versus the buy price.',
    '- HOLD / REVIEW: neither check fired. The last price can still be under the 50-day average.',
    '- REVIEW: not enough daily history.',
    '',
    briefRows(rows),
    '',
    'Reply in exactly this shape, plain text, no markdown and no stock-by-stock list:',
    'Summary: one sentence on where the rupee loss sits.',
    'Technical: one sentence on how many names are under the 50-day average, and name any RSI above 75. Use only the rows.',
    'Technical: one sentence on what that price picture means for adding money.',
    'Do not tell the reader to study fundamentals or technical indicators. These rows have no earnings, debt, or valuation, so do not invent them. State the 50-day average and RSI that are already in the rows.',
    'Do not guarantee a profit. Do not name a new stock to buy. Do not give an entry, stop-loss, or target. This is not an order.',
  ].join('\n');
}

async function generate(prompt) {
  const keys = config.geminiKeys || [];
  if (!keys.length) throw new Error('No Gemini key in .env');
  let lastError = 'Gemini request failed';
  for (const key of keys) {
    for (const model of MODELS) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4096,
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
            signal: AbortSignal.timeout(45000),
          }
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastError = redact((json.error && json.error.message) || `Gemini ${res.status}`);
          if (res.status === 400 && /thinking/i.test(lastError)) {
            const retry = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [{ text: prompt }] }],
                  generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
                }),
                signal: AbortSignal.timeout(45000),
              }
            );
            const retryJson = await retry.json().catch(() => ({}));
            if (retry.ok) {
              const retryParts = retryJson.candidates && retryJson.candidates[0] && retryJson.candidates[0].content && retryJson.candidates[0].content.parts;
              const retryText = Array.isArray(retryParts) ? retryParts.map((part) => part.text || '').join('').trim() : '';
              if (retryText) return retryText;
            }
            lastError = redact((retryJson.error && retryJson.error.message) || lastError);
          }
          if (res.status === 404) continue;
          break;
        }
        const parts = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
        const text = Array.isArray(parts) ? parts.map((part) => part.text || '').join('').trim() : '';
        const finish = json.candidates && json.candidates[0] && json.candidates[0].finishReason;
        if (text && finish !== 'MAX_TOKENS') return text;
        if (text) lastError = 'Gemini note was cut off';
        else lastError = 'Gemini returned an empty note';
      } catch (err) {
        lastError = redact(err.message);
      }
    }
  }
  throw new Error(lastError);
}

async function commentOnBook(rows, whenLabel) {
  return generate(promptFor(rows, whenLabel));
}

module.exports = { commentOnBook, redact };
