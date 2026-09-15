import { Activity } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { RunFilters } from '@/components/runs/run-filters';
import { RunsTable } from '@/components/runs/runs-table';
import { Button } from '@/components/ui/button';
import { serverApiGet } from '@/lib/server-api';
import type { RunListResponse, RunStatus, ScanListResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Çalıştırmalar' };

const RUN_STATUSES: readonly RunStatus[] = [
    'QUEUED',
    'STARTING',
    'RUNNING',
    'CANCELLING',
    'CANCELLED',
    'SUCCEEDED',
    'PARTIAL',
    'FAILED',
];

interface PageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function RunsPage({ searchParams }: PageProps) {
    const sp = await searchParams;
    const page = Math.max(1, Number(first(sp.page) ?? '1') || 1);
    const pageSize = Math.min(100, Math.max(1, Number(first(sp.pageSize) ?? '20') || 20));
    const statusParam = first(sp.status);
    const status = RUN_STATUSES.includes(statusParam as RunStatus) ? (statusParam as RunStatus) : undefined;
    const scanId = first(sp.scanId);

    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status !== undefined) params.set('status', status);
    if (scanId !== undefined && scanId !== '') params.set('scanId', scanId);

    const [runs, scans] = await Promise.all([
        serverApiGet<RunListResponse>(`/api/runs?${params.toString()}`),
        serverApiGet<ScanListResponse>('/api/scans'),
    ]);

    const scanNames = new Map(scans.rows.map((s) => [s.id, s.name]));
    const totalPages = Math.max(1, Math.ceil(runs.total / runs.pageSize));
    const hasFilters = status !== undefined || (scanId !== undefined && scanId !== '');

    return (
        <div className="space-y-4">
            <PageHeader title="Çalıştırmalar" description={`${runs.total.toLocaleString('tr-TR')} run`} />

            <RunFilters
                scans={scans.rows.map((s) => ({ id: s.id, name: s.name }))}
                currentScanId={scanId ?? ''}
                currentStatus={status ?? ''}
            />

            {runs.rows.length === 0 ? (
                <EmptyState
                    icon={Activity}
                    title={hasFilters ? 'Filtrelere uyan run yok' : 'Henüz çalıştırma yok'}
                    description={
                        hasFilters
                            ? 'Filtreleri değiştirmeyi deneyin.'
                            : 'Bir taramayı manuel veya zamanlı çalıştırdığınızda runlar burada listelenir.'
                    }
                    action={
                        hasFilters ? (
                            <Button asChild variant="outline" size="sm">
                                <Link href="/calistirmalar">Filtreleri Temizle</Link>
                            </Button>
                        ) : (
                            <Button asChild size="sm">
                                <Link href="/taramalar">Taramalara Git</Link>
                            </Button>
                        )
                    }
                />
            ) : (
                <>
                    <RunsTable rows={runs.rows} scanNames={scanNames} />
                    <RunsPagination
                        page={runs.page}
                        totalPages={totalPages}
                        total={runs.total}
                        status={status ?? ''}
                        scanId={scanId ?? ''}
                        pageSize={pageSize}
                    />
                </>
            )}
        </div>
    );
}

function RunsPagination({
    page,
    totalPages,
    total,
    status,
    scanId,
    pageSize,
}: {
    page: number;
    totalPages: number;
    total: number;
    status: string;
    scanId: string;
    pageSize: number;
}) {
    const hrefFor = (p: number) => {
        const params = new URLSearchParams({ page: String(p), pageSize: String(pageSize) });
        if (status !== '') params.set('status', status);
        if (scanId !== '') params.set('scanId', scanId);
        return `/calistirmalar?${params.toString()}`;
    };
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span className="tabular-nums">
                Sayfa {page} / {totalPages} · toplam {total.toLocaleString('tr-TR')} run
            </span>
            <div className="flex gap-2">
                {page > 1 && (
                    <Button asChild variant="outline" size="sm">
                        <Link href={hrefFor(page - 1)}>Önceki</Link>
                    </Button>
                )}
                {page < totalPages && (
                    <Button asChild variant="outline" size="sm">
                        <Link href={hrefFor(page + 1)}>Sonraki</Link>
                    </Button>
                )}
            </div>
        </div>
    );
}
