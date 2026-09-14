/**
 * Turkish text/number/date parsing helpers — pure Node-side, deterministic,
 * never throw. Used by the detail normalizer (and unit-tested directly).
 */
import { formatPrice } from './utils.js';

/**
 * Turkish-aware lowercase fold. JavaScript's `toLowerCase()` maps 'I' → 'i'
 * and leaves 'İ' as 'i' + COMBINING DOT ABOVE, which breaks naive
 * case-insensitive matching against Turkish needles ('İNŞAAT' vs 'inşaat').
 * Fold the two dotted/dotless capitals first, then lowercase.
 */
export function trLower(s: string): string {
    return s.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();
}

/**
 * Turkish month names → 1-based month number. Keys are pre-folded with
 * trLower semantics (all lowercase, dotless ı where applicable).
 */
export const TURKISH_MONTHS: Readonly<Record<string, number>> = {
    ocak: 1,
    şubat: 2,
    mart: 3,
    nisan: 4,
    mayıs: 5,
    haziran: 6,
    temmuz: 7,
    ağustos: 8,
    eylül: 9,
    ekim: 10,
    kasım: 11,
    aralık: 12,
};

const TR_DATE_RE = /(\d{1,2})\s+([A-Za-zÇĞİIÖŞÜçğıöşü]+)\s+(\d{4})/;

/**
 * Parses a Turkish display date ('14 Eylül 2026') to an ISO date string
 * ('2026-09-14'). Returns null for anything unparseable or calendrically
 * invalid (e.g. '29 Şubat 2026' — 2026 is not a leap year). Never throws.
 *
 * The regex tolerates surrounding noise (whitespace, a trailing time like
 * '15:30'); only the first day-month-year triple is used.
 */
export function parseTurkishDate(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const m = TR_DATE_RE.exec(raw);
    if (!m) return null;

    const day = Number(m[1]);
    const month = TURKISH_MONTHS[trLower(m[2] ?? '')];
    const year = Number(m[3]);
    if (!Number.isInteger(day) || !Number.isInteger(year) || month === undefined) return null;
    if (day < 1 || day > 31 || year < 1900 || year > 2200) return null;

    // Round-trip validation: Date.UTC silently rolls invalid dates over
    // (Feb 30 → Mar 2); reject when the components don't come back equal.
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
        return null;
    }

    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
}

/**
 * Parses a Turkish-formatted number ('175', '1.500', '4.500.000,50').
 * This is exactly upstream's `formatPrice` TR parsing (dots = thousands,
 * comma = decimal); aliased under a domain-neutral name for non-price fields
 * (m² areas, m² prices). Returns null on empty/unparseable input. Never throws.
 */
export function parseTrNumber(raw: string | null | undefined): number | null {
    return formatPrice(raw);
}
