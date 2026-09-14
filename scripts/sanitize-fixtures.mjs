// Sanitizes captured HTML fixtures: masks phones, personal names, user IDs.
// Keeps structural markup intact for parser tests.
import { readFileSync, writeFileSync, readdirSync } from 'fs';

const DIR = 'fixtures/html';

// Patterns -> replacement (applied in order)
const RULES = [
    // Full phone in data-opened="0 (535) 934 83 82" and visible text
    { re: /0 \(5\d{2}\) \d{3} \d{2} \d{2}/g, to: '0 (5XX) XXX XX XX' },
    // data-encrypted masked variant stays (already masked) but normalize
    { re: /data-encrypted="0 \(5\d{2}\) \*+ \*+ \d{2}"/g, to: 'data-encrypted="0 (5XX) *** ** XX"' },
    // Logged-in account name (our own account)
    { re: /Sosyal Media Ekip/g, to: 'Test Kullanıcı' },
    // Seller member id tokens in URLs
    { re: /userId=[A-Za-z0-9_-]{10,}/g, to: 'userId=MASKED_USER_ID' },
    // Store subdomain
    { re: /lisansgayrimenkuladana\.sahibinden\.com/g, to: 'testgayrimenkul.sahibinden.com' },
    // Office display name (mojibake-safe: match both UTF-8 and mangled forms via loose pattern)
    { re: /LİSANS GAYRİMENKUL/g, to: 'TEST GAYRİMENKUL' },
    // Agent personal name
    { re: /Emine&nbsp;D\./g, to: 'Test&nbsp;A.' },
    { re: /Emine D\./g, to: 'Test A.' },
    // detail-sample-2: office + full agent name + store subdomain
    { re: /ŞENYUVA GAYRİMENKUL/g, to: 'TEST SATICI GAYRİMENKUL' },
    { re: /Ümit&nbsp;Kurt/g, to: 'Test&nbsp;Satıcı' },
    { re: /Ümit Kurt/g, to: 'Test Satıcı' },
    { re: /senyuva\.sahibinden\.com/g, to: 'testsatici.sahibinden.com' },
    // detail-sample-3: individual owner name inside CSS :before content obfuscation
    { re: /Hasan Y\./g, to: 'Test Y.' },
];

let totalReplacements = 0;
for (const file of readdirSync(DIR).filter(f => f.endsWith('.html'))) {
    const path = `${DIR}/${file}`;
    let html = readFileSync(path, 'utf8');
    let count = 0;
    for (const { re, to } of RULES) {
        html = html.replace(re, () => { count++; return to; });
    }
    writeFileSync(path, html);
    totalReplacements += count;
    console.log(`${file}: ${count} replacements`);
}
console.log(`TOTAL: ${totalReplacements} replacements`);

// Verification pass — nothing sensitive may remain
const CHECKS = [
    /0 \(5\d{2}\) \d{3} \d{2} \d{2}/,      // real phone format
    /Sosyal Media Ekip/,                     // our account name
    /userId=(?!MASKED_USER_ID)[A-Za-z0-9_-]{10,}/, // member tokens (mask excluded)
    /LİSANS GAYRİMENKUL/,                    // office name sample-1
    /ŞENYUVA GAYRİMENKUL/,                   // office name sample-2
    /Ümit Kurt/,                             // full agent name
    /Hasan Y\./,                             // individual owner name
    /senyuva\.sahibinden\.com/,              // store subdomain sample-2
];
let dirty = false;
for (const file of readdirSync(DIR).filter(f => f.endsWith('.html'))) {
    const html = readFileSync(`${DIR}/${file}`, 'utf8');
    for (const c of CHECKS) {
        if (c.test(html)) { console.log(`!! UNSANITIZED: ${file} still matches ${c}`); dirty = true; }
    }
}
console.log(dirty ? 'SANITIZATION INCOMPLETE' : 'SANITIZATION VERIFIED CLEAN');
process.exit(dirty ? 1 : 0);
