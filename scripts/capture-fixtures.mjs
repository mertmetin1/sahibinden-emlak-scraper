// Captures real HTML fixtures via the trusted debug Chrome (CDP :9222)
// Usage: node scripts/capture-fixtures.mjs
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const FIXTURES = 'fixtures/html';
mkdirSync(FIXTURES, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function savePage(page, url, name, waitSel = null) {
    console.log(`→ ${name}: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    if (waitSel) await page.waitForSelector(waitSel, { timeout: 30000 }).catch(() => console.log(`  (selector ${waitSel} not seen, saving anyway)`));
    await sleep(2000);
    const html = await page.content();
    const path = `${FIXTURES}/${name}.html`;
    writeFileSync(path, html);
    console.log(`  saved ${html.length} chars → ${path}`);
}

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const page = await browser.newPage();

// 1) Category page fixture
await savePage(page, 'https://www.sahibinden.com/satilik/adana-seyhan?sorting=date_desc&pagingSize=50', 'category-satilik-adana-seyhan', 'tr.searchResultsItem');

// 2-4) Detail fixtures from real scraped listings (variety)
const listings = JSON.parse(readFileSync('storage/adana-seyhan-ilanlar.json', 'utf8'));
const picks = [listings[0], listings[5], listings[12]].filter(Boolean);
for (let i = 0; i < picks.length; i++) {
    await savePage(page, picks[i].url, `detail-sample-${i + 1}`, '#classifiedDetail');
    await sleep(4000); // be polite
}

await page.close();
await browser.disconnect();
console.log('Fixture capture complete.');
process.exit(0);
