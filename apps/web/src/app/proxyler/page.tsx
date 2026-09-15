import type { Metadata } from 'next';

import { PageHeader } from '@/components/page-header';
import { ProxyManager } from '@/components/proxies/proxy-manager';
import { serverApiGet } from '@/lib/server-api';
import type { ProxyProfileDetailDto, ProxyProfileListResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: "Proxy'ler" };

export default async function ProxiesPage() {
    const profiles = await serverApiGet<ProxyProfileListResponse>('/api/proxy-profiles');
    // Operator-scale data: fetch every profile's endpoints up front.
    const details = await Promise.all(
        profiles.rows.map((p) => serverApiGet<ProxyProfileDetailDto>(`/api/proxy-profiles/${p.id}`)),
    );

    return (
        <div className="space-y-4">
            <PageHeader
                title="Proxy'ler"
                description="Proxy profilleri ve endpoint sağlığı"
            />
            <ProxyManager profiles={profiles.rows} details={details} />
        </div>
    );
}
