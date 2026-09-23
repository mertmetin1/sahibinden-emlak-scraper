'use client';

import { useEffect, useRef } from 'react';

import { apiGet } from '@/lib/api';
import { alertHumanSolve, alertUnusualAccess, payloadKindUrl } from '@/lib/human-solve-alert';
import type { RunEventDto, RunListResponse } from '@/lib/types';

const POLL_MS = 8_000;

function unresolvedHumanSolve(events: RunEventDto[]): RunEventDto | null {
    let open: RunEventDto | null = null;
    for (const event of events) {
        if (event.type === 'HUMAN_SOLVE_REQUESTED') open = event;
        else if (event.type === 'HUMAN_SOLVE_RESOLVED') open = null;
    }
    return open;
}

/**
 * Panel-wide watcher: polls RUNNING runs so a human-solve ping fires even
 * when the operator is not on the run detail page. Dedup lives in
 * human-solve-alert (sessionStorage), so the live event log can also call it.
 */
export function HumanSolveWatcher() {
    const cursorsRef = useRef<Record<string, string>>({});

    useEffect(() => {
        let cancelled = false;

        const tick = async () => {
            try {
                const list = await apiGet<RunListResponse>('/api/runs?status=RUNNING&pageSize=20');
                if (cancelled) return;
                for (const run of list.rows) {
                    const afterId = cursorsRef.current[run.id];
                    const qs = afterId !== undefined ? `?afterId=${encodeURIComponent(afterId)}` : '';
                    const page = await apiGet<{ events: RunEventDto[]; lastEventId: string | null }>(
                        `/api/runs/${run.id}/events${qs}`,
                    );
                    if (cancelled) return;
                    if (page.lastEventId !== null) cursorsRef.current[run.id] = page.lastEventId;

                    if (afterId === undefined) {
                        const open = unresolvedHumanSolve(page.events);
                        if (open !== null) {
                            const extra = payloadKindUrl(open.data);
                            alertHumanSolve({
                                runId: run.id,
                                eventId: open.id,
                                kind: extra.kind,
                                url: extra.url,
                            });
                        }
                        const lastUnusual = [...page.events].reverse().find((event) => event.type === 'UNUSUAL_ACCESS_COOLDOWN');
                        if (lastUnusual !== undefined) {
                            const extra = payloadKindUrl(lastUnusual.data);
                            alertUnusualAccess({
                                runId: run.id,
                                eventId: lastUnusual.id,
                                resumeUrl: extra.resumeUrl ?? extra.url,
                            });
                        }
                    } else {
                        for (const event of page.events) {
                            if (event.type === 'HUMAN_SOLVE_REQUESTED') {
                                const extra = payloadKindUrl(event.data);
                                alertHumanSolve({
                                    runId: run.id,
                                    eventId: event.id,
                                    kind: extra.kind,
                                    url: extra.url,
                                });
                            } else if (event.type === 'UNUSUAL_ACCESS_COOLDOWN') {
                                const extra = payloadKindUrl(event.data);
                                alertUnusualAccess({
                                    runId: run.id,
                                    eventId: event.id,
                                    resumeUrl: extra.resumeUrl ?? extra.url,
                                });
                            }
                        }
                    }
                }
            } catch {
                // API down — health indicator already covers this
            }
        };

        void tick();
        const timer = setInterval(() => void tick(), POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    return null;
}
