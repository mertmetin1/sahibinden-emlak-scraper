'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { formatTime } from '@/lib/format';
import { describeRunEvent, runEventTone } from '@/lib/run-events';
import { streamSse } from '@/lib/sse';
import { TERMINAL_RUN_STATUSES, type RunEventDto, type RunEventMessage, type RunStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

interface LogEvent {
    id: string;
    type: string;
    at: string;
    data: unknown;
}

type ConnectionState = 'connecting' | 'live' | 'closed' | 'error';

const CURSOR_KEY = (runId: string) => `run-events-cursor:${runId}`;
const MAX_RETRIES = 8;

function maxSeq(a: string | null, b: string | null): string | null {
    if (a === null) return b;
    if (b === null) return a;
    return BigInt(a) >= BigInt(b) ? a : b;
}

/**
 * Live structured run log over SSE.
 *
 * Reconnect contract (ADR-0004): the last received event id is kept in a ref
 * AND in sessionStorage; every (re)connect — including after a full page
 * refresh — sends it as the Last-Event-ID header, so the API replays only
 * what this client hasn't seen. A terminal `RUN_END` frame (or a terminal
 * initial status) closes the stream for good.
 */
export function RunEventLog({
    runId,
    initialEvents,
    initialStatus,
}: {
    runId: string;
    initialEvents: RunEventDto[];
    initialStatus: RunStatus;
}) {
    const router = useRouter();
    const [events, setEvents] = useState<LogEvent[]>(() =>
        initialEvents.map((e) => ({ id: e.id, type: e.type, at: e.createdAt, data: e.data })),
    );
    const [status, setStatus] = useState<RunStatus>(initialStatus);
    const [connection, setConnection] = useState<ConnectionState>(
        TERMINAL_RUN_STATUSES.includes(initialStatus) ? 'closed' : 'connecting',
    );
    const [autoScroll, setAutoScroll] = useState(true);

    const seenRef = useRef<Set<string>>(new Set(initialEvents.map((e) => e.id)));
    const lastIdRef = useRef<string | null>(initialEvents.length > 0 ? (initialEvents.at(-1)?.id ?? null) : null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const connectRef = useRef<() => void>(() => undefined);

    const appendEvent = useCallback((event: LogEvent) => {
        if (seenRef.current.has(event.id)) return;
        seenRef.current.add(event.id);
        lastIdRef.current = maxSeq(lastIdRef.current, event.id);
        try {
            sessionStorage.setItem(CURSOR_KEY(runId), event.id);
        } catch {
            // sessionStorage unavailable (private mode) — in-memory cursor still works.
        }
        setEvents((prev) => [...prev, event]);
    }, [runId]);

    useEffect(() => {
        if (TERMINAL_RUN_STATUSES.includes(initialStatus)) return;

        const controller = new AbortController();
        let cancelled = false;
        let attempt = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const connect = async () => {
            if (cancelled) return;
            let stored: string | null = null;
            try {
                stored = sessionStorage.getItem(CURSOR_KEY(runId));
            } catch {
                // ignore — fall back to the in-memory cursor
            }
            const cursor = maxSeq(lastIdRef.current, stored);
            setConnection('connecting');
            try {
                for await (const frame of streamSse(`/api/runs/${runId}/events/stream`, cursor, controller.signal)) {
                    if (cancelled) return;
                    if (frame.event === 'RUN_END') {
                        try {
                            sessionStorage.removeItem(CURSOR_KEY(runId));
                        } catch {
                            // ignore
                        }
                        const payload = JSON.parse(frame.data) as { status?: unknown };
                        if (typeof payload.status === 'string') {
                            setStatus(payload.status as RunStatus);
                        }
                        setConnection('closed');
                        router.refresh(); // pull final counters into the server-rendered header
                        return;
                    }
                    const msg = JSON.parse(frame.data) as RunEventMessage;
                    setConnection('live');
                    appendEvent({ id: msg.seq, type: msg.type, at: msg.at, data: msg.data });
                }
                // Server closed without RUN_END (e.g. proxy restart) — reconnect if still active.
                if (!cancelled) {
                    attempt += 1;
                    if (attempt > MAX_RETRIES) setConnection('error');
                    else timer = setTimeout(() => void connect(), Math.min(2000 * attempt, 10_000));
                }
            } catch {
                if (cancelled || controller.signal.aborted) return;
                attempt += 1;
                if (attempt > MAX_RETRIES) setConnection('error');
                else timer = setTimeout(() => void connect(), Math.min(2000 * attempt, 10_000));
            }
        };
        connectRef.current = () => {
            attempt = 0;
            void connect();
        };
        void connect();

        return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
            controller.abort();
        };
    }, [runId, initialStatus, appendEvent, router]);

    useEffect(() => {
        if (autoScroll && scrollRef.current !== null) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [events, autoScroll]);

    const failedEvents = events.filter((e) => e.type === 'REQUEST_FAILED');

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader className="flex-row items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <CardTitle>Canlı Olay Akışı</CardTitle>
                        <ConnectionBadge state={connection} status={status} />
                    </div>
                    <div className="flex items-center gap-3">
                        {connection === 'error' && (
                            <Button variant="outline" size="sm" onClick={() => connectRef.current()}>
                                <RefreshCw />
                                Yeniden Bağlan
                            </Button>
                        )}
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Switch checked={autoScroll} onCheckedChange={setAutoScroll} />
                            Otomatik kaydır
                        </label>
                    </div>
                </CardHeader>
                <CardContent>
                    <div
                        ref={scrollRef}
                        className="h-[420px] overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs"
                    >
                        {events.length === 0 ? (
                            <p className="p-2 font-sans text-sm text-muted-foreground">
                                Henüz olay yok — worker run&apos;ı aldığında olaylar burada akar.
                            </p>
                        ) : (
                            <ul className="space-y-1">
                                {events.map((event) => (
                                    <li key={event.id} className="flex items-start gap-2">
                                        <span className="shrink-0 text-muted-foreground tabular-nums">
                                            {formatTime(event.at)}
                                        </span>
                                        <Badge variant={runEventTone(event.type)} className="shrink-0 font-sans">
                                            {event.type}
                                        </Badge>
                                        <span className="min-w-0 break-words font-sans text-foreground">
                                            {describeRunEvent(event.type, event.data)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </CardContent>
            </Card>

            {failedEvents.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle>Başarısız İstekler ({failedEvents.length})</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <ul className="space-y-2 text-sm">
                            {failedEvents.map((event) => {
                                const d = (typeof event.data === 'object' && event.data !== null
                                    ? event.data
                                    : {}) as Record<string, unknown>;
                                return (
                                    <li key={event.id} className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant="destructive">{String(d.errorCode ?? 'HATA')}</Badge>
                                            <span className="break-all font-mono text-xs text-muted-foreground">
                                                {String(d.url ?? '')}
                                            </span>
                                        </div>
                                        <p className="mt-1 text-xs">{String(d.message ?? '')}</p>
                                    </li>
                                );
                            })}
                        </ul>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

function ConnectionBadge({ state, status }: { state: ConnectionState; status: RunStatus }) {
    if (state === 'live' || state === 'connecting') {
        return (
            <Badge variant="info" className="gap-1.5">
                <span className={cn('inline-block size-1.5 rounded-full bg-primary', state === 'live' && 'animate-pulse')} />
                {state === 'live' ? 'Canlı' : 'Bağlanıyor…'}
            </Badge>
        );
    }
    if (state === 'error') return <Badge variant="destructive">Bağlantı Koptu</Badge>;
    return <Badge variant="secondary">Kapandı ({status})</Badge>;
}
