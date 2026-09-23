'use client';

import { useCallback, useEffect, useState } from 'react';

import type { HealthResponse } from '@/lib/types';
import { cn } from '@/lib/utils';

const POLL_INTERVAL_MS = 10_000;

type HealthState =
    | { kind: 'loading' }
    | { kind: 'ok'; health: HealthResponse }
    | { kind: 'error' };

/**
 * API + worker health dots in the topbar — polls GET /health every 10s.
 */
export function HealthIndicator() {
    const [state, setState] = useState<HealthState>({ kind: 'loading' });

    const check = useCallback(async () => {
        try {
            const res = await fetch('/health', { cache: 'no-store' });
            const body = (await res.json()) as HealthResponse;
            if (res.ok && body.status === 'ok') {
                setState({ kind: 'ok', health: body });
            } else {
                setState({ kind: 'error' });
            }
        } catch {
            setState({ kind: 'error' });
        }
    }, []);

    useEffect(() => {
        void check();
        const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [check]);

    const up = state.kind === 'ok';
    const workerUp = state.kind === 'ok' && state.health.worker === 'up';
    const title =
        state.kind === 'ok'
            ? `API ${state.health.status} — db: ${state.health.db}, redis: ${state.health.redis}, worker: ${state.health.worker}`
            : state.kind === 'loading'
              ? 'API durumu kontrol ediliyor…'
              : 'API erişilemiyor veya degrade (db/redis)';

    return (
        <div className="flex items-center gap-3 text-xs text-muted-foreground" title={title}>
            <div className="flex items-center gap-2">
                <span
                    className={cn(
                        'inline-block size-2 rounded-full',
                        up ? 'bg-success' : state.kind === 'loading' ? 'bg-muted-foreground/50' : 'bg-destructive',
                        up && 'shadow-[0_0_0_3px] shadow-success/20',
                    )}
                />
                <span className="hidden sm:inline">API {up ? 'Bağlı' : state.kind === 'loading' ? '…' : 'Hata'}</span>
            </div>
            <div className="hidden items-center gap-2 sm:flex">
                <span
                    className={cn(
                        'inline-block size-2 rounded-full',
                        state.kind === 'loading'
                            ? 'bg-muted-foreground/50'
                            : workerUp
                              ? 'bg-success'
                              : 'bg-warning',
                    )}
                />
                <span>Worker {state.kind === 'loading' ? '…' : workerUp ? 'Bağlı' : 'Kapalı'}</span>
            </div>
        </div>
    );
}
