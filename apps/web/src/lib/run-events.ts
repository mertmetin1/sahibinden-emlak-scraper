/**
 * Run event presentation: Turkish one-line messages per event type and chip
 * tones. Payloads are `unknown` (pre-redacted API-side); every field read is
 * type-guarded so a shape change degrades to the raw type name, never a crash.
 */

export type EventTone = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' | 'info';

function asRecord(data: unknown): Record<string, unknown> {
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function describeRunEvent(type: string, data: unknown): string {
    const d = asRecord(data);
    switch (type) {
        case 'RUN_STARTED': {
            const urls = num(d.startUrlCount);
            const mode = str(d.browserMode);
            return `Run başladı${urls !== null ? ` — ${urls} hedef URL` : ''}${mode !== null ? `, mod ${mode}` : ''}`;
        }
        case 'CATEGORY_STARTED':
            return `Kategori sayfası açılıyor: ${str(d.url) ?? '?'}${num(d.pageNumber) !== null ? ` (sayfa ${num(d.pageNumber)})` : ''}`;
        case 'CATEGORY_PARSED':
            return `Kategori işlendi: ${num(d.listingsFound) ?? '?'} ilan bulundu, ${num(d.newListings) ?? '?'} yeni`;
        case 'LISTING_DISCOVERED':
            return `İlan keşfedildi: ${str(d.title) ?? str(d.sourceListingId) ?? '?'}`;
        case 'DETAIL_STARTED':
            return `Detay sayfası açılıyor: ${str(d.sourceListingId) ?? str(d.url) ?? '?'}`;
        case 'DETAIL_PARSED':
            return `Detay işlendi: ${str(d.sourceListingId) ?? '?'} (${num(d.attributesCount) ?? '?'} özellik, ${num(d.imagesCount) ?? '?'} görsel)`;
        case 'LISTING_INSERTED':
            return `Yeni ilan eklendi: ${str(d.sourceListingId) ?? str(d.listingId) ?? '?'}`;
        case 'LISTING_UPDATED': {
            const fields = Array.isArray(d.changedFields) ? d.changedFields.filter((f) => typeof f === 'string').join(', ') : '';
            return `İlan güncellendi: ${str(d.sourceListingId) ?? '?'}${fields !== '' ? ` (${fields})` : ''}`;
        }
        case 'PRICE_CHANGED':
            return `Fiyat değişti: ${str(d.sourceListingId) ?? '?'} — ${num(d.oldPriceAmount) ?? '?'} → ${num(d.newPriceAmount) ?? '?'} ${str(d.priceCurrency) ?? ''}`;
        case 'REQUEST_RETRY':
            return `Yeniden deneme ${num(d.attempt) ?? '?'}/${num(d.maxRetries) ?? '?'}: ${str(d.url) ?? '?'} (${str(d.errorCode) ?? '?'})`;
        case 'REQUEST_FAILED':
            return `İstek başarısız: ${str(d.url) ?? '?'} — ${str(d.message) ?? str(d.errorCode) ?? '?'}`;
        case 'SESSION_RETIRED':
            return `Oturum emekliye ayrıldı (${str(d.reason) ?? 'bilinmiyor'})`;
        case 'CHALLENGE_DETECTED':
            return `Challenge tespit edildi: ${str(d.kind) ?? '?'} — ${str(d.url) ?? '?'}`;
        case 'HUMAN_SOLVE_REQUESTED':
            return `İnsan doğrulaması bekleniyor (${str(d.kind) ?? 'challenge'}): debug Chrome’da geçin — ${str(d.url) ?? '?'}`;
        case 'HUMAN_SOLVE_RESOLVED':
            return `Doğrulama geçti, tarama devam ediyor${str(d.url) !== null ? `: ${str(d.url)}` : ''}`;
        case 'BATCH_COOLDOWN':
            return `Batch molası: ${num(d.detailsWritten) ?? '?'} detay, ${num(d.cooldownMs) !== null ? `${Math.round((num(d.cooldownMs) ?? 0) / 1000)}s` : '?'}`;
        case 'PROXY_ROTATED':
            return `Proxy hop: ${num(d.detailsWritten) ?? '?'} detay, ${num(d.cooldownMs) !== null ? `${Math.round((num(d.cooldownMs) ?? 0) / 1000)}s mola` : 'mola'}, devam ${str(d.resumeUrl) ?? '?'}`;
        case 'UNUSUAL_ACCESS_COOLDOWN':
            return `Olağan dışı erişim — 10 dk mola, çerezler temizlenip devam: ${str(d.resumeUrl) ?? str(d.url) ?? '?'}`;
        case 'DETAIL_UNAVAILABLE':
            return `Detay yayında değil: ${str(d.listingId) ?? str(d.url) ?? '?'}`;
        case 'RUN_COMPLETED':
            return `Run tamamlandı: ${str(d.status) ?? '?'}`;
        case 'RUN_FAILED':
            return `Run başarısız: ${str(d.errorSummary) ?? str(d.errorCode) ?? '?'}`;
        default:
            return type;
    }
}

export function runEventTone(type: string): EventTone {
    if (type === 'REQUEST_FAILED' || type === 'RUN_FAILED') return 'destructive';
    if (
        type === 'REQUEST_RETRY' ||
        type === 'SESSION_RETIRED' ||
        type === 'PROXY_FAILURE' ||
        type === 'CHALLENGE_DETECTED' ||
        type === 'HUMAN_SOLVE_REQUESTED' ||
        type === 'UNUSUAL_ACCESS_COOLDOWN' ||
        type === 'PROXY_ROTATED'
    ) {
        return 'warning';
    }
    if (type === 'HUMAN_SOLVE_RESOLVED') return 'success';
    if (type === 'LISTING_DISCOVERED' || type === 'LISTING_INSERTED') return 'success';
    if (type === 'LISTING_UPDATED' || type === 'PRICE_CHANGED') return 'info';
    if (type === 'RUN_STARTED' || type === 'RUN_COMPLETED') return 'default';
    return 'secondary';
}
