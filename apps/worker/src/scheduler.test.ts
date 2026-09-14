/**
 * computeDueScans / latestOccurrenceWithin — pure scheduler logic.
 * No Redis, no database: the matrix covers due / not-due / already-active /
 * already-fired / timezone / invalid-schedule.
 */
import { describe, expect, it } from 'vitest';
import { computeDueScans, latestOccurrenceWithin } from './scheduler.js';
import type { RecentRunSummary, SchedulableScan } from './scheduler.js';

const NOW = new Date('2026-09-14T10:00:30.000Z'); // Monday 10:00:30 UTC

function scan(id: string, schedule: string, timezone = 'Europe/Istanbul'): SchedulableScan {
    return { id, name: `scan-${id}`, schedule, timezone };
}

function run(overrides: Partial<RecentRunSummary>): RecentRunSummary {
    return { status: 'SUCCEEDED', trigger: 'SCHEDULE', createdAt: NOW, ...overrides };
}

describe('latestOccurrenceWithin', () => {
    it('returns the latest occurrence ≤ now inside the window', () => {
        // Every minute: at 10:00:30 the latest occurrence is 10:00:00.
        const occurrence = latestOccurrenceWithin('* * * * *', 'Europe/Istanbul', NOW, 60_000);
        expect(occurrence?.toISOString()).toBe('2026-09-14T10:00:00.000Z');
    });

    it('returns null when the last occurrence is outside the window', () => {
        // Daily 03:00 Istanbul (= 00:00 UTC): 10 hours before NOW.
        expect(latestOccurrenceWithin('0 3 * * *', 'Europe/Istanbul', NOW, 60_000)).toBeNull();
    });

    it('evaluates the wall-clock pattern in the given timezone', () => {
        // 12:30 Istanbul (UTC+3) = 09:30 UTC. At 09:30:20 UTC the Istanbul
        // evaluation is 20s past the occurrence; UTC evaluation is ~22h away.
        const at = new Date('2026-09-14T09:30:20.000Z');
        expect(latestOccurrenceWithin('30 12 * * *', 'Europe/Istanbul', at, 60_000)?.toISOString()).toBe(
            '2026-09-14T09:30:00.000Z',
        );
        expect(latestOccurrenceWithin('30 12 * * *', 'UTC', at, 60_000)).toBeNull();
    });
});

describe('computeDueScans', () => {
    const everyMinute = scan('a', '* * * * *');
    const occurrence = new Date('2026-09-14T10:00:00.000Z');

    it('marks a scan due when an occurrence is inside the window and nothing blocks it', () => {
        const decisions = computeDueScans([everyMinute], NOW, new Map());
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({ scanId: 'a', due: true, reason: 'due' });
        expect(decisions[0]?.occurrence?.toISOString()).toBe(occurrence.toISOString());
    });

    it('marks a scan not-due when no occurrence falls inside the window', () => {
        const decisions = computeDueScans([scan('b', '0 3 * * *')], NOW, new Map());
        expect(decisions[0]).toMatchObject({ scanId: 'b', due: false, reason: 'not-due', occurrence: null });
    });

    it.each(['QUEUED', 'STARTING', 'RUNNING', 'CANCELLING'] as const)(
        'suppresses the fire while a run is active (%s)',
        (status) => {
            const recent = [run({ status, createdAt: new Date('2026-09-14T09:58:00.000Z') })];
            const decisions = computeDueScans([everyMinute], NOW, new Map([['a', recent]]));
            expect(decisions[0]).toMatchObject({ due: false, reason: 'already-active' });
        },
    );

    it('suppresses a double fire when a SCHEDULE run already exists for this occurrence', () => {
        const recent = [run({ trigger: 'SCHEDULE', status: 'SUCCEEDED', createdAt: new Date('2026-09-14T10:00:05.000Z') })];
        const decisions = computeDueScans([everyMinute], NOW, new Map([['a', recent]]));
        expect(decisions[0]).toMatchObject({ due: false, reason: 'already-fired' });
    });

    it('does NOT suppress for a MANUAL run created after the occurrence', () => {
        const recent = [run({ trigger: 'MANUAL', status: 'SUCCEEDED', createdAt: new Date('2026-09-14T10:00:05.000Z') })];
        const decisions = computeDueScans([everyMinute], NOW, new Map([['a', recent]]));
        expect(decisions[0]).toMatchObject({ due: true, reason: 'due' });
    });

    it('does NOT suppress for a SCHEDULE run of the PREVIOUS occurrence', () => {
        const recent = [run({ trigger: 'SCHEDULE', status: 'SUCCEEDED', createdAt: new Date('2026-09-14T09:59:05.000Z') })];
        const decisions = computeDueScans([everyMinute], NOW, new Map([['a', recent]]));
        expect(decisions[0]).toMatchObject({ due: true, reason: 'due' });
    });

    it('timezone decides due-ness for the same instant', () => {
        const at = new Date('2026-09-14T09:30:20.000Z');
        const istanbul = scan('ist', '30 12 * * *', 'Europe/Istanbul');
        const utc = scan('utc', '30 12 * * *', 'UTC');
        const decisions = computeDueScans([istanbul, utc], at, new Map());
        expect(decisions.find((d) => d.scanId === 'ist')).toMatchObject({ due: true, reason: 'due' });
        expect(decisions.find((d) => d.scanId === 'utc')).toMatchObject({ due: false, reason: 'not-due' });
    });

    it('reports invalid cron expressions instead of throwing', () => {
        const decisions = computeDueScans([scan('bad', 'not-a-cron')], NOW, new Map());
        expect(decisions[0]).toMatchObject({ due: false, reason: 'invalid-schedule' });
        expect(decisions[0]?.error).toBeTruthy();
    });

    it('falls back to Europe/Istanbul when timezone is empty', () => {
        const at = new Date('2026-09-14T09:30:20.000Z');
        const decisions = computeDueScans([scan('tz', '30 12 * * *', '')], at, new Map());
        expect(decisions[0]).toMatchObject({ due: true, reason: 'due' });
    });
});
