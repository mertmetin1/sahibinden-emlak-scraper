import type { Metadata } from 'next';

import { PageHeader } from '@/components/page-header';
import { CookieProfilesSection } from '@/components/sessions/cookie-profiles-section';
import { SessionPoliciesSection } from '@/components/sessions/session-policies-section';
import { serverApiGet } from '@/lib/server-api';
import type { CookieProfileListResponse, SessionPolicyListResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Oturumlar' };

export default async function SessionsPage() {
    const [cookieProfiles, sessionPolicies] = await Promise.all([
        serverApiGet<CookieProfileListResponse>('/api/cookie-profiles'),
        serverApiGet<SessionPolicyListResponse>('/api/session-policies'),
    ]);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Oturumlar"
                description="Çerez profilleri (yalnızca meta veri) ve oturum politikaları"
            />
            <CookieProfilesSection profiles={cookieProfiles.rows} />
            <SessionPoliciesSection policies={sessionPolicies.rows} />
        </div>
    );
}
