/**
 * tr-TR formatting helpers. All functions tolerate null/undefined and return
 * '—' for missing values so tables stay dense and honest.
 */

const numberFmt = new Intl.NumberFormat('tr-TR');
const dateTimeFmt = new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const relativeFmt = new Intl.RelativeTimeFormat('tr', { numeric: 'auto' });

/** Site currency strings → ISO 4217 (sahibinden shows "TL", "$", "€"…). */
const CURRENCY_MAP: Record<string, string> = {
    TL: 'TRY',
    TRY: 'TRY',
    '₺': 'TRY',
    $: 'USD',
    USD: 'USD',
    '€': 'EUR',
    EUR: 'EUR',
    '£': 'GBP',
    GBP: 'GBP',
};

export function formatNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return numberFmt.format(value);
}

export function formatPrice(amount: number | null | undefined, currency: string | null | undefined): string {
    if (amount === null || amount === undefined) return '—';
    const iso = currency !== null && currency !== undefined ? CURRENCY_MAP[currency.toUpperCase()] ?? undefined : undefined;
    if (iso !== undefined) {
        try {
            return new Intl.NumberFormat('tr-TR', {
                style: 'currency',
                currency: iso,
                maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
            }).format(amount);
        } catch {
            // Unknown ISO code — fall through to plain formatting.
        }
    }
    return `${numberFmt.format(amount)} ${currency ?? ''}`.trim();
}

function toDate(value: string | Date | null | undefined): Date | null {
    if (value === null || value === undefined) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value: string | Date | null | undefined): string {
    const d = toDate(value);
    return d === null ? '—' : dateTimeFmt.format(d);
}

export function formatDate(value: string | Date | null | undefined): string {
    const d = toDate(value);
    return d === null ? '—' : dateFmt.format(d);
}

export function formatTime(value: string | Date | null | undefined): string {
    const d = toDate(value);
    return d === null ? '—' : timeFmt.format(d);
}

/** '5 dk önce' style relative time (tr locale), absolute fallback beyond 30 days. */
export function relativeTime(value: string | Date | null | undefined, now: Date = new Date()): string {
    const d = toDate(value);
    if (d === null) return '—';
    const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
    const abs = Math.abs(diffSec);
    if (abs < 45) return 'az önce';
    if (abs < 90) return relativeFmt.format(Math.trunc(diffSec / 60), 'minute');
    if (abs < 3600) return relativeFmt.format(Math.trunc(diffSec / 60), 'minute');
    if (abs < 86400) return relativeFmt.format(Math.trunc(diffSec / 3600), 'hour');
    if (abs < 86400 * 30) return relativeFmt.format(Math.trunc(diffSec / 86400), 'day');
    return dateTimeFmt.format(d);
}

/** '1 sa 5 dk', '2 dk 14 sn', '850 ms' — compact duration. */
export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${numberFmt.format(ms)} ms`;
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours} sa ${minutes} dk`;
    if (minutes > 0) return `${minutes} dk ${seconds} sn`;
    return `${seconds} sn`;
}

/** Signed percent with ▲/▼ arrow, e.g. '▲ %2,5' / '▼ %1,2'. */
export function formatPriceChange(percent: number | null | undefined): { text: string; direction: 'up' | 'down' | 'flat' } | null {
    if (percent === null || percent === undefined) return null;
    const direction = percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat';
    const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '■';
    const absText = `%${numberFmt.format(Math.round(Math.abs(percent) * 100) / 100)}`;
    return { text: `${arrow} ${absText}`, direction };
}

export function shortId(id: string): string {
    return id.slice(0, 8);
}
