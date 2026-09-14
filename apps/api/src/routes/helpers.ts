/**
 * Shared route helpers.
 */
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';

interface ProfileRefs {
    proxyProfileId?: string | null | undefined;
    cookieProfileId?: string | null | undefined;
    sessionPolicyId?: string | null | undefined;
}

/**
 * Referenced profile ids must exist (400 PROFILE_NOT_FOUND otherwise).
 * Only non-null ids present in `refs` are checked.
 */
export async function assertProfilesExist(app: FastifyInstance, refs: ProfileRefs): Promise<void> {
    if (refs.proxyProfileId != null) {
        const profile = await app.proxyProfiles.getProfile(refs.proxyProfileId);
        if (profile === null) {
            throw new ApiError(400, 'PROFILE_NOT_FOUND', `proxy profile not found: ${refs.proxyProfileId}`, {
                field: 'proxyProfileId',
            });
        }
    }
    if (refs.cookieProfileId != null) {
        const profile = await app.cookieProfiles.getProfile(refs.cookieProfileId);
        if (profile === null) {
            throw new ApiError(400, 'PROFILE_NOT_FOUND', `cookie profile not found: ${refs.cookieProfileId}`, {
                field: 'cookieProfileId',
            });
        }
    }
    if (refs.sessionPolicyId != null) {
        const policy = await app.sessionPolicies.getById(refs.sessionPolicyId);
        if (policy === null) {
            throw new ApiError(400, 'PROFILE_NOT_FOUND', `session policy not found: ${refs.sessionPolicyId}`, {
                field: 'sessionPolicyId',
            });
        }
    }
}
