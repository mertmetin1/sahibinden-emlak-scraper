// Sahibinden scraper — drives the user's REAL Chrome via CDP (no bot detection)
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync } from 'fs';

const START_URL = process.env.SCRAPE_URL || 'https://www.sahibinden.com/satilik/adana-seyhan?sorting=date_desc&pagingSize=50';
const MAX_ITEMS = process.env.SCRAPE_MAX ? parseInt(process.env.SCRAPE_MAX) : null;
const OUT_FILE = process.env.SCRAPE_OUT || 'storage/adana-seyhan-ilanlar.json';
const PAGE_DELAY = [4000, 8000]; // ms, random between

const input = JSON.parse(readFileSync('storage/key_value_stores/default/INPUT.json', 'utf8'));
const cookies = input.sessionCookies;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = ([a, b]) => Math.floor(Math.random() * (b - a + 1)) + a;

function isChallenge(html, url) {
    return /Basılı Tutun|px-captcha|Press &amp; Hold|Press & Hold|Just a moment|Güvenlik doğrulaması|Bir dakika lütfen|Olağan dışı erişim/i.test(html)
        || url.includes('/giris') || url.includes('/olagan-disi-kullanim');
}

async function waitClear(page) {
    let warned = false;
    for (; ;) {
        await sleep(2500);
        const html = await page.content().catch(() => '');
        const url = page.url();
        if (!html) continue; // mid-navigation
        if (!isChallenge(html, url)) return;
        if (!warned) {
            console.log('>>> DOGRULAMA GEREKLI: Chrome penceresinde coz (Basili Tut / robot degilim). Bekleniyor...');
            warned = true;
        }
    }
}

function parsePrice(priceStr) {
    if (!priceStr) return null;
    const numericStr = priceStr.replace(/[^0-9,.]/g, '').replace(/\./g, '').replace(/,/g, '.');
    const price = parseFloat(numericStr);
    return isNaN(price) ? null : price;
}

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
console.log('Chrome\'a baglanildi:', await browser.version());

const page = await browser.newPage();

// Inject session cookies (login session, PX device cookies, etc.)
const formatted = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.sahibinden.com',
    path: c.path || '/',
    secure: true,
}));
await page.setCookie(...formatted);
console.log(`${formatted.length} cookie enjekte edildi`);

console.log('Gidiliyor:', START_URL);
await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(e => console.log('goto warn:', e.message));
await waitClear(page);

const all = [];
const seen = new Set();

for (let pageNum = 1; ; pageNum++) {
    try {
        await page.waitForSelector('tr.searchResultsItem', { timeout: 30000 });
    } catch {
        console.log('Tablo bulunamadi, challenge kontrolu...');
        await waitClear(page);
        try {
            await page.waitForSelector('tr.searchResultsItem', { timeout: 30000 });
        } catch {
            console.log('Hala yok, sayfa atlaniyor. URL:', page.url());
            break;
        }
    }

    const items = await page.$$eval('tr.searchResultsItem', rows => rows.map(row => {
        const q = (sel) => row.querySelector(sel);
        const titleEl = q('td.searchResultsTitleValue a.classifiedTitle');
        const priceEl = q('td.searchResultsPriceValue span');
        const locEl = q('td.searchResultsLocationValue');
        const dateEl = q('td.searchResultsDateValue');
        const imgEl = row.querySelector('img');
        const attrs = [...row.querySelectorAll('td.searchResultsAttributeValue')].map(e => e.textContent.trim());
        return {
            id: row.getAttribute('data-id'),
            url: titleEl ? titleEl.href : null,
            title: titleEl ? titleEl.textContent.trim() : null,
            price_raw: priceEl ? priceEl.textContent.trim() : null,
            location: locEl ? locEl.innerText.trim().replace(/\n/g, ' / ') : null,
            date: dateEl ? dateEl.innerText.trim().replace(/\n/g, ' ') : null,
            attrs,
            image: imgEl ? (imgEl.src || imgEl.dataset.src || null) : null,
        };
    }));

    let added = 0;
    for (const it of items) {
        if (!it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        it.price = parsePrice(it.price_raw);
        all.push(it);
        added++;
        if (MAX_ITEMS && all.length >= MAX_ITEMS) break;
    }
    console.log(`Sayfa ${pageNum}: +${added} ilan (toplam ${all.length})`);

    if (MAX_ITEMS && all.length >= MAX_ITEMS) break;

    // Next page
    const nextHref = await page.$eval('a.prevNextBut[title="Sonraki"]:not(.passive)', a => a.href).catch(() => null);
    if (!nextHref) {
        console.log('Sonraki sayfa yok — bitti.');
        break;
    }
    await sleep(rand(PAGE_DELAY));
    await page.goto(nextHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('next warn:', e.message));
    await waitClear(page);
}

writeFileSync(OUT_FILE, JSON.stringify(all, null, 2));
console.log(`BITTI: ${all.length} ilan -> ${OUT_FILE}`);
await page.close();
await browser.disconnect();
process.exit(0);
