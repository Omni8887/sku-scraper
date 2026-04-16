const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TARGET_URL = process.argv[2] || 'https://www.vivaeshop.cz/koupelny/sprchy?manufacturer=6400';
const OUTPUT_FILE = process.argv[3] || 'sku_output.txt';

// Vzory pre rozpoznanie SKU / article number
const SKU_PATTERNS = [
  /[A-Z0-9]{2,6}[-\/][A-Z0-9\-\/]{2,20}/g,   // napr. 26010000, AB-1234-XX
  /\b\d{5,12}\b/g,                              // číselné SKU (5-12 číslic)
  /[A-Z]{1,4}\d{4,10}/g,                        // písmeno + čísla
];

// CSS selektory pre produkt linky (upraviť podľa stránky)
const PRODUCT_LINK_SELECTORS = [
  'a.product-item__link',
  'a.product__link',
  '.product-list a[href*="/p/"]',
  '.product-list a[href*="/produkt"]',
  '.product-list a[href*="/product"]',
  'a[href*="/detail"]',
  '.product-card a',
  'article a',
  '.item a',
];

// SKU selektory na detail stránke
const SKU_DETAIL_SELECTORS = [
  '[itemprop="sku"]',
  '[data-sku]',
  '.product-sku',
  '.sku',
  '.article-number',
  '.product-code',
  '#sku',
  '[class*="sku"]',
  '[class*="artno"]',
  '[class*="article"]',
  '[class*="reference"]',
  'td:has(+ td)',
  'dt',
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function extractSKUsFromText(text) {
  const found = new Set();
  for (const pattern of SKU_PATTERNS) {
    const matches = text.match(pattern) || [];
    matches.forEach(m => found.add(m.trim()));
  }
  return [...found];
}

function log(msg, emoji = '→') {
  const time = new Date().toLocaleTimeString('sk-SK');
  console.log(`[${time}] ${emoji} ${msg}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  log(`Spúšťam SKU scraper`, '🚀');
  log(`URL: ${TARGET_URL}`);
  log(`Výstup: ${OUTPUT_FILE}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1400, height: 900 });

  const allSKUs = new Map(); // url → [skus]

  // ─── 1. ZBIERANIE LINIEK NA PRODUKTY ────────────────────────────────────────
  log(`Otvárám kategóriu...`, '🌐');

  let productLinks = [];
  let page_num = 1;
  let currentUrl = TARGET_URL;

  while (true) {
    log(`Stránka ${page_num}: ${currentUrl}`);
    await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Zber liniek
    const links = await page.evaluate((selectors) => {
      const found = new Set();
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          const href = el.href || el.getAttribute('href');
          if (href && !href.includes('#') && !href.includes('javascript')) {
            found.add(href);
          }
        });
      }
      // Fallback – všetky linky čo obsahujú typické product URL vzory
      document.querySelectorAll('a[href]').forEach(el => {
        const href = el.href;
        if (
          href.includes('/p/') ||
          href.includes('/produkt') ||
          href.includes('/product') ||
          href.includes('/detail') ||
          href.match(/\/[a-z0-9-]{10,}\/[a-z0-9-]{5,}\/?$/)
        ) {
          found.add(href);
        }
      });
      return [...found];
    }, PRODUCT_LINK_SELECTORS);

    const newLinks = links.filter(l =>
      !productLinks.includes(l) &&
      !l.includes('?') || l === currentUrl
    );
    productLinks.push(...links.filter(l => !productLinks.includes(l)));
    log(`Nájdených ${links.length} liniek (spolu: ${productLinks.length})`, '🔗');

    // Ďalšia stránka (pagination)
    const nextPageUrl = await page.evaluate((base) => {
      const next = document.querySelector(
        'a[rel="next"], a.next, a[aria-label="Next"], .pagination__next a, [class*="next"] a'
      );
      return next ? next.href : null;
    });

    if (!nextPageUrl || nextPageUrl === currentUrl || page_num >= 20) break;
    currentUrl = nextPageUrl;
    page_num++;
    await page.waitForTimeout(800);
  }

  log(`Celkovo ${productLinks.length} produktových liniek`, '✅');

  if (productLinks.length === 0) {
    log('Žiadne linky nenájdené! Skontroluj URL alebo selektory.', '⚠️');
    await browser.close();
    return;
  }

  // ─── 2. NAVŠTÍVENIE KAŽDÉHO PRODUKTU ────────────────────────────────────────
  for (let i = 0; i < productLinks.length; i++) {
    const url = productLinks[i];
    log(`[${i + 1}/${productLinks.length}] ${url}`, '📦');

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
      await page.waitForTimeout(800);

      const skus = await page.evaluate((detailSelectors, patterns) => {
        const found = new Set();

        // 1. Hľadaj v dedikovaných SKU elementoch
        for (const sel of detailSelectors) {
          document.querySelectorAll(sel).forEach(el => {
            const text = el.textContent.trim();
            if (text.length > 2 && text.length < 50) {
              // Ak obsahuje číslo, pravdepodobne je to SKU
              if (/\d/.test(text)) found.add(text);
            }
            // Data atribúty
            ['data-sku', 'data-id', 'data-code', 'data-artno', 'content'].forEach(attr => {
              const val = el.getAttribute(attr);
              if (val && /\d/.test(val) && val.length > 3) found.add(val.trim());
            });
          });
        }

        // 2. Hľadaj v meta tagoch
        document.querySelectorAll('meta').forEach(meta => {
          const name = (meta.getAttribute('name') || meta.getAttribute('property') || '').toLowerCase();
          const content = meta.getAttribute('content') || '';
          if ((name.includes('sku') || name.includes('article') || name.includes('product:id')) && content) {
            found.add(content.trim());
          }
        });

        // 3. Hľadaj v JSON-LD
        document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
          try {
            const data = JSON.parse(script.textContent);
            const extract = (obj) => {
              if (!obj) return;
              if (obj.sku) found.add(String(obj.sku).trim());
              if (obj.gtin) found.add(String(obj.gtin).trim());
              if (obj.mpn) found.add(String(obj.mpn).trim());
              if (Array.isArray(obj)) obj.forEach(extract);
              if (typeof obj === 'object') Object.values(obj).forEach(v => {
                if (typeof v === 'object') extract(v);
              });
            };
            extract(data);
          } catch (e) {}
        });

        return [...found];
      }, SKU_DETAIL_SELECTORS, SKU_PATTERNS.map(p => p.source));

      if (skus.length > 0) {
        allSKUs.set(url, skus);
        log(`  → SKU: ${skus.join(', ')}`, '✓');
      } else {
        log(`  → Žiadne SKU nenájdené`, '–');
      }

    } catch (err) {
      log(`  → CHYBA: ${err.message}`, '❌');
    }

    // Zdvorilostnÿ delay (0.5–1.5s)
    await page.waitForTimeout(500 + Math.random() * 1000);
  }

  await browser.close();

  // ─── 3. ZÁPIS DO TXT ────────────────────────────────────────────────────────
  const lines = [];
  lines.push(`SKU SCRAPER – Výsledky`);
  lines.push(`URL: ${TARGET_URL}`);
  lines.push(`Dátum: ${new Date().toLocaleString('sk-SK')}`);
  lines.push(`Produktov skontrolovaných: ${productLinks.length}`);
  lines.push(`Produktov so SKU: ${allSKUs.size}`);
  lines.push('─'.repeat(60));

  // Zoznam všetkých unikátnych SKU
  const uniqueSKUs = new Set();
  allSKUs.forEach(skus => skus.forEach(s => uniqueSKUs.add(s)));

  lines.push(`\nVŠETKY UNIKÁTNE SKU (${uniqueSKUs.size} kusov):`);
  lines.push('─'.repeat(60));
  [...uniqueSKUs].forEach(sku => lines.push(sku));

  lines.push('\n' + '─'.repeat(60));
  lines.push('\nDETAIL PO PRODUKTOCH:');
  lines.push('─'.repeat(60));
  allSKUs.forEach((skus, url) => {
    lines.push(`\n${url}`);
    skus.forEach(sku => lines.push(`  → ${sku}`));
  });

  fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
  log(`\nHotovo! Výsledky uložené do: ${OUTPUT_FILE}`, '🎉');
  log(`Unikátnych SKU: ${uniqueSKUs.size}`, '📊');
})();
