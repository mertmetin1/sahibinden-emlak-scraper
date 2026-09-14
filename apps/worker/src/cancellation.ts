/**
 * RedisCancellationToken — the engine's cooperative-cancellation port backed
 * by the Redis cancel key (ARCHITECTURE.md §6.2).
 *
 * The API sets `RedisKeys.cancelKey(runId)` (PX 10 min) when a RUNNING run is
 * cancelled; this token polls the key (default every 2s — the "≤2s
 * granularity" of §6.2) and flips `isCancelled`. The engine checks the flag
 * between page loads and drains the Crawlee autoscaled pool.
 *
 * `requestCancel()` flips the flag LOCALLY (no Redis write) — used by the
 * graceful-shutdown path, which must work even if Redis is already gone.
 */
import type { CancellationToken, RuntimeLogger } from '@sahibindenbot/shared';
import type { Redis } from 'ioredis';
import { defaultKeyBuilders } from './keys.js';

export const CANCEL_POLL_INTERVAL_MS = 2_000;

export interface RedisCancellationTokenOptions {
    pollIntervalMs?: number;
    keyBuilder?: (runId: string) => string;
    logger?: RuntimeLogger;
    /** Fired exactly once when the token flips (either source). */
    onCancel?: (reason: string) => void;
}

export class RedisCancellationToken implements CancellationToken {
    private cancelled = false;
    private reason: string | null = null;
    private disposed = false;
    private readonly timer: NodeJS.Timeout;
    private readonly key: string;

    constructor(
        private readonly redis: Redis,
        private readonly runId: string,
        private readonly options: RedisCancellationTokenOptions = {},
    ) {
        this.key = (options.keyBuilder ?? defaultKeyBuilders.cancelKey)(runId);
        this.timer = setInterval(() => {
            void this.poll();
        }, options.pollIntervalMs ?? CANCEL_POLL_INTERVAL_MS);
        // Never hold the event loop (or a vitest worker) open for a poll timer.
        this.timer.unref?.();
    }

    get isCancelled(): boolean {
        return this.cancelled;
    }

    /** Why the run was cancelled ('cancel requested via API' | 'worker shutdown'). */
    get cancelReason(): string | null {
        return this.reason;
    }

    /** Immediate out-of-band check (used right after STARTING, before RUNNING). */
    async checkNow(): Promise<boolean> {
        await this.poll();
        return this.cancelled;
    }

    /** Local flip — graceful shutdown. Idempotent. */
    requestCancel(reason = 'worker shutdown'): void {
        this.flip(reason);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        clearInterval(this.timer);
    }

    private async poll(): Promise<void> {
        if (this.disposed || this.cancelled) return;
        let value: string | null;
        try {
            value = await this.redis.get(this.key);
        } catch (err) {
            // A transient Redis hiccup must not crash the poll loop NOR cancel
            // the run — the next tick retries.
            this.options.logger?.warn('cancel-key poll failed (will retry)', {
                runId: this.runId,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }
        if (value !== null) this.flip('cancel requested via API');
    }

    private flip(reason: string): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.reason = reason;
        this.options.onCancel?.(reason);
    }
}
