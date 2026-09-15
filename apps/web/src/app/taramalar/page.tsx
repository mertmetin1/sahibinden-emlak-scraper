import { Plus, Radar } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ScansTable } from '@/components/scans/scans-table';
import { Button } from '@/components/ui/button';
import { serverApiGet } from '@/lib/server-api';
import type { ScanListResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Taramalar' };

export default async function ScansPage() {
    const scans = await serverApiGet<ScanListResponse>('/api/scans');

    return (
        <div className="space-y-4">
            <PageHeader
                title="Taramalar"
                description={`${scans.total} tarama tanımı`}
                actions={
                    <Button asChild size="sm">
                        <Link href="/taramalar/new">
                            <Plus />
                            Yeni Tarama
                        </Link>
                    </Button>
                }
            />
            {scans.rows.length === 0 ? (
                <EmptyState
                    icon={Radar}
                    title="Henüz tarama tanımı yok"
                    description="Bir tarama; hedef URL'ler, limitler, proxy/oturum ayarları ve zamanlamadan oluşur."
                    action={
                        <Button asChild size="sm">
                            <Link href="/taramalar/new">İlk Taramayı Oluştur</Link>
                        </Button>
                    }
                />
            ) : (
                <ScansTable rows={scans.rows} />
            )}
        </div>
    );
}
