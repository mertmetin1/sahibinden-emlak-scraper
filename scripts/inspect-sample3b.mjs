// Locate the seller section in detail-sample-3
import { readFileSync } from 'fs';

const c = readFileSync('fixtures/html/detail-sample-3.html', 'utf8');

const idx = c.indexOf('username-info-box');
if (idx >= 0) {
    console.log('--- username-info-box context ---');
    console.log(c.substring(idx - 200, idx + 800).replace(/\s+/g, ' '));
} else {
    console.log('username-info-box not found');
}

// Also check store-info contexts
let i = 0, n = 0;
while ((i = c.indexOf('store-info', i + 1)) >= 0 && n < 4) {
    n++;
    console.log(`--- store-info #${n} ---`);
    console.log(c.substring(Math.max(0, i - 60), i + 300).replace(/\s+/g, ' '));
}
