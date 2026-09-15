/**
 * Tiny Turkish cron descriptor for common 5-field expressions. Returns null
 * for anything outside the recognized shapes — callers then show the raw
 * expression (never a wrong guess).
 */

const DAY_NAMES = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const DAY_NAMES_SHORT = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

function pad2(value: string): string {
    return value.padStart(2, '0');
}

function isNumeric(value: string): boolean {
    return /^\d+$/.test(value);
}

/** '0 9 * * *' → 'Her gün 09:00'; 'STAR/15 * * * *' (star-slash) → 'Her 15 dakikada bir'; … */
export function describeCron(expression: string | null | undefined): string | null {
    if (expression === null || expression === undefined) return null;
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const [minute = '', hour = '', dayOfMonth = '', , dayOfWeek = ''] = fields;

    // */n * * * * → her n dakikada
    const everyMinute = /^\*\/(\d+)$/.exec(minute);
    if (everyMinute !== null && hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
        return `Her ${everyMinute[1]} dakikada bir`;
    }

    // m */n * * * → her n saatte
    const everyHour = /^\*\/(\d+)$/.exec(hour);
    if (isNumeric(minute) && everyHour !== null && dayOfMonth === '*' && dayOfWeek === '*') {
        return `Her ${everyHour[1]} saatte bir`;
    }

    if (!isNumeric(minute) || !isNumeric(hour)) return null;
    const time = `${pad2(hour)}:${pad2(minute)}`;

    // m h * * * → her gün
    if (dayOfMonth === '*' && dayOfWeek === '*') return `Her gün ${time}`;

    // m h * * 1-5 → hafta içi
    if (dayOfMonth === '*' && dayOfWeek === '1-5') return `Hafta içi her gün ${time}`;

    // m h * * 0,6 → hafta sonu
    if (dayOfMonth === '*' && dayOfWeek === '0,6') return `Hafta sonu ${time}`;

    // m h * * d → her <gün>
    if (dayOfMonth === '*' && isNumeric(dayOfWeek)) {
        const day = DAY_NAMES[Number(dayOfWeek) % 7];
        return day !== undefined ? `Her ${day} ${time}` : null;
    }

    // m h * * d,d,d → <günler> günleri
    if (dayOfMonth === '*' && /^[\d,]+$/.test(dayOfWeek)) {
        const names = dayOfWeek
            .split(',')
            .map((d) => DAY_NAMES_SHORT[Number(d) % 7])
            .filter((n): n is string => n !== undefined);
        if (names.length > 0) return `${names.join(', ')} günleri ${time}`;
        return null;
    }

    // m h d * * → her ayın d. günü
    if (isNumeric(dayOfMonth) && dayOfWeek === '*') return `Her ayın ${dayOfMonth}. günü ${time}`;

    return null;
}

/** Preview text for the scan editor: human text, else the raw expression. */
export function cronPreview(expression: string | null | undefined): string {
    if (expression === null || expression === undefined || expression.trim() === '') return 'Zamanlama yok (manuel)';
    return describeCron(expression) ?? expression;
}
