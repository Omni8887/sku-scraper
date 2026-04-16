const puppeteer = require('puppeteer');
const fs = require('fs');

const TARGET_URL = process.argv[2] || 'https://www.vivaeshop.cz/koupelny/sprchy?manufacturer=6400';
const OUTPUT_FILE = process.argv[3] || 'sku_output.txt';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PRODUCT_LINK_SELECTORS = [
  'a.product-item__link', 'a.product__link',
  '.product-list a[href*="/p/"]', '.product-list a[href*="/produkt"]',
  '.product-list a[href*="/product"]', 'a[href*="/detail"]',
  '.product-card a', 'article a', '.item a',
];

const SKU_DETAIL_SELECTORS = [
  '[itemprop="sku"]', '[data-sku]', '.product-sku', '.sku',
  '.article-number', '.product-code', '#sku',
  '[class*="sku"]', '[class*="artno"]', '[class*="article"]',
  '[class*="reference"]', 'dt',
];

function log(msg, emoji = '') {
  const time = new Date().toLocaleTimeString('sk-SK');
  console.log(`[${time}] ${emoji} ${msg}`);
}

(async () => {
  log('Spustam SKU scraper', '🚀');
  log(`URL: ${TARGET_URL}`);
  log(`Vystup: ${OUTPUT_FILE}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1400, height: 900 });

  const allSKUs = new Map();
  let productLinks = [];
  let page_num = 1;
  let currentUrl = TARGET_URL;

  log('Otvaram kategoriu...', '🌐');

  while (true) {
    log(`Stranka ${page_num}: ${currentUrl}`);
    await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1500);

    const links = await page.evaluate((selectors) => {
      const found = new Set();
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          const href = el.href || el.getAttribute('href');
          if (href && !href.includes('#') && !href.includes('javascript')) found.add(href);
        });
      }
      document.querySelectorAll('a[href]').forEach(el => {
        const href = el.href;
        if (href.includes('/p/') || href.includes('/produkt') || href.includes('/product') || href.includes('/detail')) {
          found.add(href);
        }
      });
      return [...found];
    }, PRODUCT_LINK_SELECTORS);

    productLinks.push(...links.filter(l => !productLinks.includes(l)));
    log(`Najdenych ${links.length} liniek (spolu: ${productLinks.length})`, '🔗');

    const nextPageUrl = await page.evaluate(() => {
      const next = document.querySelector('a[rel="next"], a.next, .pagination__next a, [class*="next"] a');
      return next ? next.href : null;
    });

    if (!nextPageUrl || nextPageUrl === currentUrl || page_num >= 20) break;
    currentUrl = nextPageUrl;
    page_num++;
    await sleep(800);
  }

  log(`Celkovo ${productLinks.length} produktovych liniek`, '✅');

  if (productLinks.length === 0) {
    log('Ziadne linky nenajdene!', '⚠️');
    await browser.close();
    return;
  }

  for (let i = 0; i < productLinks.length; i++) {
    const url = productLinks[i];
    log(`[${i + 1}/${productLinks.length}] ${url}`, '📦');

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
      await sleep(800);

      const skus = await page.evaluate((detailSelectors) => {
        const found = new Set();

        for (const sel of detailSelectors) {
          document.querySelectorAll(sel).forEach(el => {
            const text = el.textContent.trim();
            if (text.length > 2 && text.length < 50 && /\d/.test(text)) found.add(text);
            ['data-sku', 'data-id', 'data-code', 'data-artno', 'content'].forEach(attr => {
              const val = el.getAttribute(attr);
              if (val && /\d/.test(val) && val.length > 3) found.add(val.trim());
            });
          });
        }

        document.querySelectorAll('meta').forEach(meta => {
          const name = (meta.getAttribute('name') || meta.getAttribute('property') || '').toLowerCase();
          const content = meta.getAttribute('content') || '';
          if ((name.includes('sku') || name.includes('article') || name.includes('product:id')) && content) {
            found.add(content.trim());
          }
        });

        document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
          try {
            const data = JSON.parse(script.textContent);
            const extract = (obj) => {
              if (!obj) return;
              if (obj.sku) found.add(String(obj.sku).trim());
              if (obj.gtin) found.add(String(obj.gtin).trim());
              if (obj.mpn) found.add(String(obj.mpn).trim());
              if (Array.isArray(obj)) obj.forEach(extract);
              if (typeof obj === 'object') Object.values(obj).forEach(v => { if (typeof v === 'object') extract(v); });
            };
            extract(data);
          } catch (e) {}
        });

        return [...found];
      }, SKU_DETAIL_SELECTORS);

      if (skus.length > 0) {
        allSKUs.set(url, skus);
        log(`  -> SKU: ${skus.join(', ')}`);
      } else {
        log(`  -> Ziadne SKU nenajdene`);
      }
    } catch (err) {
      log(`  -> CHYBA: ${err.message}`, '❌');
    }

    await sleep(500 + Math.random() * 1000);
  }

  await browser.close();

  const lines = [];
  lines.push('SKU SCRAPER - Vysledky');
  lines.push(`URL: ${TARGET_URL}`);
  lines.push(`Datum: ${new Date().toLocaleString('sk-SK')}`);
  lines.push(`Produktov skontrolovanych: ${productLinks.length}`);
  lines.push(`Produktov so SKU: ${allSKUs.size}`);
  lines.push('-'.repeat(60));

  const uniqueSKUs = new Set();
  allSKUs.forEach(skus => skus.forEach(s => uniqueSKUs.add(s)));

  lines.push(`\nVSETKY UNIKATNE SKU (${uniqueSKUs.size} kusov):`);
  lines.push('-'.repeat(60));
  [...uniqueSKUs].forEach(sku => lines.push(sku));

  lines.push('\n' + '-'.repeat(60));
  lines.push('\nDETAIL PO PRODUKTOCH:');
  lines.push('-'.repeat(60));
  allSKUs.forEach((skus, url) => {
    lines.push(`\n${url}`);
    skus.forEach(sku => lines.push(`  -> ${sku}`));
  });

  fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
  log(`Hotovo! Vysledky ulozene do: ${OUTPUT_FILE}`, '🎉');
  log(`Unikatnych SKU: ${uniqueSKUs.size}`, '📊');
})();
