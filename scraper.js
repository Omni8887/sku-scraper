const puppeteer = require('puppeteer');
const fs = require('fs');

const TARGET_URL = process.argv[2] || 'https://www.vivaeshop.sk/kupelne/sprchy/rucne-sprchy';
const OUTPUT_FILE = process.argv[3] || 'sku_output.txt';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg, emoji = '') {
  const time = new Date().toLocaleTimeString('sk-SK');
  console.log(`[${time}] ${emoji} ${msg}`);
}

// Zoznam slov ktore nie su SKU (casti nazvov produktov v URL)
const NOT_SKU_WORDS = [
  'chrom', 'chrome', 'cierna', 'biela', 'black', 'white', 'matna', 'lesklá',
  'alpska', 'komplet', 'kompletna', 'sada', 'system', 'sprcha', 'sprchovy',
  'rucna', 'hlavova', 'bateria', 'termostat', 'edition', 'vytok', 'tyc',
  'antivandalovy', 'podomietkovy', 'mm', 'cm', 'jet', 'prudom', 'prudy',
  'set', 'sada', 'profil', 'rama', 'sifon', 'biela', 'support', 'rama'
];

function isValidSKU(str) {
  if (!str) return false;
  const s = str.toLowerCase();
  // Prilis kratke
  if (str.length < 4) return false;
  // Je to len slovo z nazvu produktu?
  if (NOT_SKU_WORDS.includes(s)) return false;
  // Musi obsahovat aspon jedno cislo alebo byt alfanumericky kod
  if (!/\d/.test(str) && !/^[A-Z]{2,}-/.test(str)) return false;
  return true;
}

// Extrahuje SKU zo stranky - viacero metod
async function extractSKUFromPage(page) {
  return await page.evaluate(() => {
    // Metoda 1: itemprop="sku"
    const skuEl = document.querySelector('[itemprop="sku"]');
    if (skuEl && skuEl.textContent.trim()) return skuEl.textContent.trim();

    // Metoda 2: dt/dd tabulka – hladame label "SKU" alebo "Kod produktu"
    const dts = document.querySelectorAll('dt');
    for (const dt of dts) {
      const label = dt.textContent.trim().toUpperCase();
      if (label === 'SKU' || label === 'KÓD PRODUKTU' || label === 'KOD PRODUKTU' || label === 'ARTICLE') {
        const dd = dt.nextElementSibling;
        if (dd) return dd.textContent.trim();
      }
    }

    // Metoda 3: element s class obsahujucou "sku" alebo "code"
    const skuClass = document.querySelector('.sku, .product-sku, .product-code, [class*="sku"], [data-sku]');
    if (skuClass) {
      const val = skuClass.getAttribute('data-sku') || skuClass.textContent.trim();
      if (val && val.length > 2) return val;
    }

    // Metoda 4: JSON-LD
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const find = (obj) => {
          if (!obj || typeof obj !== 'object') return null;
          if (obj.sku) return String(obj.sku);
          if (obj.mpn) return String(obj.mpn);
          for (const v of Object.values(obj)) {
            const r = find(Array.isArray(v) ? { _: v } : v);
            if (r) return r;
          }
          return null;
        };
        const result = find(data);
        if (result) return result;
      } catch(e) {}
    }

    return null;
  });
}

// Extrahuje SKU z URL ako zaloha
function extractSKUFromURL(url) {
  try {
    const path = new URL(url).pathname;
    const slug = path.split('/').filter(Boolean).pop() || '';
    const parts = slug.split('-');

    // SKU je zvyčajne posledná časť (1-3 segmenty) ktora vyzera ako kod
    // Skusame od konca: 1 segment, potom 2, potom 3
    for (let take = 1; take <= 3; take++) {
      const candidate = parts.slice(-take).join('-').toUpperCase();
      // Validny SKU: obsahuje cislo ALEBO je vzor ako SC-5200, NOAD-1503
      if (/\d/.test(candidate) && candidate.length >= 4) {
        // Nesmie to byt len cislo ktore je rok alebo mm rozmery
        if (candidate.length >= 6 || /[A-Z]/.test(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  } catch(e) {
    return null;
  }
}

// Ocisti SKU - odstran prefix vyrobcu ak existuje (napr. "HG 26270000" -> "26270000")
function cleanSKU(sku) {
  if (!sku) return null;
  // Odstran prefix typu "HG ", "GR ", "DU " atd (2-4 pismena + medzera)
  return sku.replace(/^[A-Z]{1,4}\s+/, '').trim();
}

(async () => {
  log('Spustam SKU scraper pre VivaEshop', '🚀');
  log(`URL: ${TARGET_URL}`);
  log(`Vystup: ${OUTPUT_FILE}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1400, height: 900 });

  // ─── 1. ZBIERANIE LINIEK ──────────────────────────────────────────────────
  let productLinks = [];
  let page_num = 1;
  let currentUrl = TARGET_URL;

  log('Zberam linky na produkty...', '🌐');

  while (true) {
    log(`Stranka ${page_num}: ${currentUrl}`);
    try {
      await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch(e) {
      log(`Timeout, pokracujem...`);
    }
    await sleep(1500);

    const links = await page.evaluate(() => {
      const found = new Set();
      const SKIP = /\/(kupelne|toalety|kuchyne|spa|vypredaj|brands|blog|kontakt|account|checkout|customer|media|static|planner|faq|collections|kolekcie)\b/;
      document.querySelectorAll('a[href]').forEach(el => {
        const href = el.href;
        if (
          href.includes('vivaeshop') &&
          !href.includes('?') &&
          !SKIP.test(href) &&
          href.match(/\/[a-z0-9][a-z0-9-]{15,}$/)
        ) {
          found.add(href);
        }
      });
      return [...found];
    });

    const newLinks = links.filter(l => !productLinks.includes(l));
    productLinks.push(...newLinks);
    log(`  Novych liniek: ${newLinks.length} (spolu: ${productLinks.length})`, '🔗');

    const nextUrl = await page.evaluate(() => {
      const next = document.querySelector('a[rel="next"]');
      return next ? next.href : null;
    });

    if (!nextUrl || nextUrl === currentUrl || page_num >= 30) break;
    currentUrl = nextUrl;
    page_num++;
    await sleep(800);
  }

  log(`Celkovo ${productLinks.length} produktovych liniek`, '✅');

  if (productLinks.length === 0) {
    log('Ziadne produkty nenajdene!', '⚠️');
    await browser.close();
    return;
  }

  // ─── 2. NAVSTIVENIE PRODUKTOV ─────────────────────────────────────────────
  const results = [];
  let skuFromPage = 0;
  let skuFromUrl = 0;

  for (let i = 0; i < productLinks.length; i++) {
    const url = productLinks[i];
    log(`[${i + 1}/${productLinks.length}] ${url}`, '📦');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(600);

      // Primarna metoda: zo stranky
      let rawSku = await extractSKUFromPage(page);
      let sku = cleanSKU(rawSku);
      let source = 'page';

      // Zaloha: z URL
      if (!sku || !isValidSKU(sku)) {
        const urlSku = extractSKUFromURL(url);
        if (urlSku && isValidSKU(urlSku)) {
          sku = urlSku;
          source = 'url';
        } else {
          sku = null;
        }
      }

      if (sku) {
        results.push({ url, sku, source });
        if (source === 'page') skuFromPage++;
        else skuFromUrl++;
        log(`  -> ${sku}  [zdroj: ${source}]`, '✅');
      } else {
        log(`  -> SKU nenajdene`);
      }
    } catch (err) {
      log(`  -> CHYBA: ${err.message}`, '❌');
    }

    await sleep(400 + Math.random() * 600);
  }

  await browser.close();

  // ─── 3. ZAPIS ─────────────────────────────────────────────────────────────
  const lines = [];
  lines.push('SKU SCRAPER - Vysledky (VivaEshop)');
  lines.push(`URL: ${TARGET_URL}`);
  lines.push(`Datum: ${new Date().toLocaleString('sk-SK')}`);
  lines.push(`Produktov preskenovanych: ${productLinks.length}`);
  lines.push(`SKU najdenych celkovo: ${results.length}`);
  lines.push(`  - zo stranky: ${skuFromPage}`);
  lines.push(`  - z URL (zaloha): ${skuFromUrl}`);
  lines.push('='.repeat(60));
  lines.push('');
  lines.push('ZOZNAM SKU (len kody):');
  lines.push('-'.repeat(60));
  results.forEach(r => lines.push(r.sku));

  lines.push('');
  lines.push('='.repeat(60));
  lines.push('DETAIL (SKU | zdroj | URL):');
  lines.push('-'.repeat(60));
  results.forEach(r => {
    lines.push(`${r.sku}  |  ${r.source}  |  ${r.url}`);
  });

  fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
  log(`Hotovo! Subor: ${OUTPUT_FILE}`, '🎉');
  log(`Celkovo SKU: ${results.length} / ${productLinks.length}`, '📊');
})();
