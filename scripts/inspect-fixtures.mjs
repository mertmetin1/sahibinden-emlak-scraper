// Inspect seller identity fields in detail fixtures
import { readFileSync } from 'fs';

for (const f of ['detail-sample-1.html', 'detail-sample-2.html', 'detail-sample-3.html']) {
    const c = readFileSync(`fixtures/html/${f}`, 'utf8');
    console.log('===', f);
    let m = c.match(/sticky-header-store-name[^>]*>\s*<a[^>]*>\s*([^<]+)/);
    console.log('store  :', m ? m[1].trim() : '-');
    m = c.match(/sticky-header-name[^>]*>\s*([^<]+)/);
    console.log('agent  :', m ? m[1].trim() : '-');
    m = c.match(/data-opened="([^"]+)"/);
    console.log('phone  :', m ? m[1] : '-');
    m = c.match(/class="name-surname">([^<]+)/);
    console.log('account:', m ? m[1].trim() : '-');
    m = c.match(/https:\/\/([a-z0-9-]+)\.sahibinden\.com\?userId=/);
    console.log('subdom :', m ? m[1] : '-');
    // owner-type pages: "Sahibinden" seller block
    m = c.match(/username-info-box[^>]*>[\s\S]{0,200}?<[^>]+>([^<]{3,60})</);
    console.log('owner  :', m ? m[1].trim() : '-');
}
