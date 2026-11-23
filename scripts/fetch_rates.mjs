import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT_PATH = path.resolve('docs/rates.json');

function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch {
    return { providers: [] };
  }
}

function extractPlausibleKwdRates(text, min = 0.0048, max = 0.0076) {
  const matches = String(text).match(/0\.00[4-8]\d{1,5}/g) || [];
  const nums = matches.map(Number).filter(n => isFinite(n) && n >= min && n <= max);
  return [...new Set(nums)];
}

async function fetchMidMarket() {
  const res = await fetch('https://open.er-api.com/v6/latest/KWD', { cache: 'no-store' });
  if (!res.ok) throw new Error('Mid-market HTTP ' + res.status);
  const json = await res.json();
  const egp = Number(json?.rates?.EGP);
  if (!isFinite(egp) || egp <= 0) throw new Error('Invalid EGP mid-market');
  return {
    egpPerKwd: Number(egp.toFixed(4)),
    kwdPerEgp: Number((1 / egp).toFixed(7)),
    updatedUtc: json.time_last_update_utc || new Date().toUTCString()
  };
}

// Extracts the exact table row (<tr>) matching any regex in patterns inside a live rendered page
async function extractRowRateFromPage(page, url, patterns, { min = 0.0050, max = 0.0075, waitMs = 3500 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(waitMs);

  const rowTexts = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr, [role="row"], .rate-row, .currency-row'));
    return rows.map(r => (r.innerText || r.textContent || '').replace(/\s+/g, ' ').trim());
  });

  for (const text of rowTexts) {
    if (patterns.some(pat => pat.test(text))) {
      const nums = extractPlausibleKwdRates(text, min, max);
      if (nums.length > 0) {
        // Transfer sell rate is the higher of Buy/Sell in KWD-per-EGP terms
        return Math.max(...nums);
      }
    }
  }

  // Fallback: tight 90-char window after currency label in rendered body text
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' '));
  for (const pat of patterns) {
    const idx = bodyText.search(pat);
    if (idx !== -1) {
      const slice = bodyText.slice(idx, idx + 90);
      const nums = extractPlausibleKwdRates(slice, min, max);
      if (nums.length > 0) return Math.max(...nums);
    }
  }

  throw new Error('Could not find EGP rate row');
}

async function fetchAlMullaLive(page, midMarket) {
  try {
    await page.goto('https://www.almullaexchange.com/ar/country/send-money-to-egypt', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(4500);
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' '));
    // Look for "1 KWD = 171.xx EGP" or "1 د.ك = 171.xx"
    const m = bodyText.match(/(?:1\s*(?:KWD|د\.ك)\s*=\s*)(\d{3}(?:\.\d{1,4})?)/i);
    if (m) {
      const egp = Number(m[1]);
      if (isFinite(egp) && egp >= 120 && egp <= 250) {
        return { kwdPerEgp: Number((1 / egp).toFixed(7)), estimated: false, note: 'مباشر من موقع الملا' };
      }
    }
  } catch (e) {
    console.warn('Al Mulla live widget fallback:', e.message);
  }
  const estEgp = midMarket.egpPerKwd * (1 - 0.005);
  return {
    kwdPerEgp: Number((1 / estEgp).toFixed(7)),
    estimated: true,
    note: 'تقديري حسب السوق (-0.5%)'
  };
}

async function main() {
  const prev = loadPrevious();
  const prevMap = new Map((prev.providers || []).map(p => [p.id, p]));

  let midMarket;
  try {
    midMarket = await fetchMidMarket();
  } catch (e) {
    console.warn('Mid-market fallback:', e.message);
    midMarket = prev.midMarket || { egpPerKwd: 171.19, kwdPerEgp: 0.0058415, updatedUtc: new Date().toUTCString() };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1366, height: 900 }
  });

  const targets = [
    {
      id: 'cbk',
      name: 'البنك التجاري',
      type: 'bank',
      fee: 0,
      url: 'https://www.cbk.com/ar/Rates--Markets/Foreign-Exchange-Rates',
      patterns: [/جنيه مصري/, /Egyptian\s*Pound/i, /\bEGP\b/],
      min: 0.0052,
      max: 0.0075
    },
    {
      id: 'kfh',
      name: 'بيت التمويل الكويتي',
      type: 'bank',
      fee: 0,
      url: 'https://www.kfh.com/en/home/Personal/Tools-services/Currency-Rates.html',
      patterns: [/\bEGP\b/, /Egyptian\s*Pound/i],
      min: 0.0050,
      max: 0.0075
    },
    {
      id: 'burgan',
      name: 'بنك برقان',
      type: 'bank',
      fee: 0,
      url: 'https://burgan.com/en/currency/bbcurrency-convertor/',
      patterns: [/\bEGP\b/, /Egyptian\s*Pound/i],
      min: 0.0050,
      max: 0.0075
    },
    {
      id: 'gulfbank',
      name: 'بنك الخليج',
      type: 'bank',
      fee: 0,
      url: 'https://www.e-gulfbank.com/en/treasury/tools/exchange-rates/',
      patterns: [/EGP\*/, /\bEGP\b/, /Egyptian\s*Pound/i],
      min: 0.0050,
      max: 0.0075
    },
    {
      id: 'boubyan',
      name: 'بنك بوبيان',
      type: 'bank',
      fee: 0,
      url: 'https://www.bankboubyan.com/en/exchange-rates',
      patterns: [/\bEGP\b/, /Egyptian\s*Pound/i],
      min: 0.0050,
      max: 0.0078
    },
    {
      id: 'nbk',
      name: 'بنك الكويت الوطني',
      type: 'bank',
      fee: 0,
      url: 'https://www.nbk.com/kuwait/personal/investments/currency-rates.html',
      patterns: [/\bEGP\b/, /Egyptian\s*Pound/i],
      min: 0.0050,
      max: 0.0075
    }
  ];

  const providers = [];

  for (const t of targets) {
    const page = await context.newPage();
    try {
      const rate = await extractRowRateFromPage(page, t.url, t.patterns, { min: t.min, max: t.max });
      console.log(`OK [${t.id}]: ${rate}`);
      providers.push({
        id: t.id,
        name: t.name,
        type: t.type,
        fee: t.fee,
        kwdPerEgp: rate,
        live: true,
        sourceNote: 'مباشر من موقع البنك',
        updatedAt: new Date().toISOString(),
        url: t.url
      });
    } catch (err) {
      console.warn(`MISS [${t.id}]:`, err.message);
      const old = prevMap.get(t.id);
      providers.push({
        id: t.id,
        name: t.name,
        type: t.type,
        fee: t.fee,
        kwdPerEgp: old?.kwdPerEgp ?? null,
        live: false,
        sourceNote: old?.kwdPerEgp ? 'آخر سعر محفوظ' : 'تعذر السحب — أدخل السعر يدوياً',
        updatedAt: old?.updatedAt ?? null,
        url: t.url
      });
    } finally {
      await page.close();
    }
  }

  // Al Mulla Exchange
  const mullaPage = await context.newPage();
  const mulla = await fetchAlMullaLive(mullaPage, midMarket);
  await mullaPage.close();
  providers.push({
    id: 'almulla',
    name: 'الملا للصرافة',
    type: 'exchange',
    fee: 1.5,
    kwdPerEgp: mulla.kwdPerEgp,
    live: !mulla.estimated,
    estimated: mulla.estimated,
    sourceNote: mulla.note,
    updatedAt: new Date().toISOString(),
    url: 'https://www.almullaexchange.com/ar/country/send-money-to-egypt'
  });

  await browser.close();

  const output = {
    fetchedAt: new Date().toISOString(),
    midMarket,
    providers
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log('WROTE:', OUT_PATH);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
