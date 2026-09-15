import type { Metadata } from 'next';

import { PageHeader } from '@/components/page-header';
import { ScanForm } from '@/components/scans/scan-form';
import { serverApiGet } from '@/lib/server-api';
import type { CookieProfileListResponse, ProxyProfileListResponse, SessionPolicyListResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Yeni Tarama' };

export default async function NewScanPage() {
    const [proxyProfiles, cookieProfiles, sessionPolicies] = await Promise.all([
        serverApiGet<ProxyProfileListResponse>('/api/proxy-profiles'),
        serverApiGet<CookieProfileListResponse>('/api/cookie-profiles'),
        serverApiGet<SessionPolicyListResponse>('/api/session-policies'),
    ]);

    return (
        <div>
            <PageHeader title="Yeni Tarama" description="Yeni bir tarama tanımı oluşturun" />
            <ScanForm
                mode="create"
                proxyProfiles={proxyProfiles.rows}
                cookieProfiles={cookieProfiles.rows}
                sessionPolicies={sessionPolicies.rows}
            />
        </div>
    );
}
