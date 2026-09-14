// Find seller block structure in detail-sample-3 (individual owner?)
import { readFileSync } from 'fs';

const c = readFileSync('fixtures/html/detail-sample-3.html', 'utf8');

for (const pat of ['user-info', 'store-info', 'username-info', 'seller', 'Sahibinden.com üyesi', 'bireysel', 'owner']) {
    const count = (c.match(new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    console.log(`${pat}: ${count}`);
}

// Print context around first user-info hit
const idx = c.indexOf('user-info');
if (idx >= 0) {
    console.log('--- user-info context ---');
    console.log(c.substring(idx - 100, idx + 700).replace(/\s+/g, ' '));
}
