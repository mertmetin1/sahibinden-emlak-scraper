import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/page-header';
import { ScanForm } from '@/components/scans/scan-form';
import { ServerApiError, serverApiGet } from '@/lib/server-api';
import type {
    CookieProfileListResponse,
    ProxyProfileListResponse,
    ScanDto,
    SessionPolicyListResponse,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tarama Düzenle' };

interface PageProps {
    params: Promise<{ id: string }>;
}

export default async function EditScanPage({ params }: PageProps) {
    const { id } = await params;

    let scan: ScanDto;
    let proxyProfiles: ProxyProfileListResponse;
    let cookieProfiles: CookieProfileListResponse;
    let sessionPolicies: SessionPolicyListResponse;
    try {
        [scan, proxyProfiles, cookieProfiles, sessionPolicies] = await Promise.all([
            serverApiGet<ScanDto>(`/api/scans/${id}`),
            serverApiGet<ProxyProfileListResponse>('/api/proxy-profiles'),
            serverApiGet<CookieProfileListResponse>('/api/cookie-profiles'),
            serverApiGet<SessionPolicyListResponse>('/api/session-policies'),
        ]);
    } catch (err) {
        if (err instanceof ServerApiError && err.status === 404) notFound();
        throw err;
    }

    return (
        <div>
            <PageHeader title={scan.name} description="Tarama tanımını düzenleyin" />
            {/* key remounts the form after save/duplicate so state matches the server */}
            <ScanForm
                key={`${scan.id}-${scan.updatedAt}`}
                mode="edit"
                initial={scan}
                proxyProfiles={proxyProfiles.rows}
                cookieProfiles={cookieProfiles.rows}
                sessionPolicies={sessionPolicies.rows}
            />
        </div>
    );
}
