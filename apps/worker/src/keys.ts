/**
 * Redis key/channel builders — production defaults come from shared's
 * RedisKeys (single source of truth shared with the API). Tests inject a
 * `sahtest:`-prefixed variant so the real keyspace is never touched.
 */
import { RedisKeys } from '@sahibindenbot/shared';

export interface KeyBuilders {
    cancelKey: (runId: string) => string;
    scanLockKey: (scanDefinitionId: string) => string;
    runEventsChannel: (runId: string) => string;
}

export const defaultKeyBuilders: KeyBuilders = {
    cancelKey: RedisKeys.cancelKey,
    scanLockKey: RedisKeys.scanLockKey,
    runEventsChannel: RedisKeys.runEventsChannel,
};

/** Wraps the production builders with a prefix (test isolation). */
export function prefixKeyBuilders(prefix: string): KeyBuilders {
    return {
        cancelKey: (runId) => `${prefix}${RedisKeys.cancelKey(runId)}`,
        scanLockKey: (scanDefinitionId) => `${prefix}${RedisKeys.scanLockKey(scanDefinitionId)}`,
        runEventsChannel: (runId) => `${prefix}${RedisKeys.runEventsChannel(runId)}`,
    };
}
