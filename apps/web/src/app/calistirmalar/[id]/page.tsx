import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/page-header';
import { RunActions } from '@/components/runs/run-actions';
import { RunEventLog } from '@/components/runs/run-event-log';
import { SnapshotViewer } from '@/components/runs/snapshot-viewer';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime, formatDuration, formatNumber, shortId } from '@/lib/format';
import { RUN_STATUS_LABELS, RUN_STATUS_TONES, RUN_TRIGGER_LABELS } from '@/lib/labels';
import { ServerApiError, serverApiGet } from '@/lib/server-api';
import type { RunDetailDto, ScanListResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Run Detayı' };

interface PageProps {
    params: Promise<{ id: string }>;
}

export default async function RunDetailPage({ params }: PageProps) {
    const { id } = await params;

    let run: RunDetailDto;
    let scans: ScanListResponse;
    try {
        [run, scans] = await Promise.all([
            serverApiGet<RunDetailDto>(`/api/runs/${id}`),
            serverApiGet<ScanListResponse>('/api/scans'),
        ]);
    } catch (err) {
        if (err instanceof ServerApiError && err.status === 404) notFound();
        throw err;
    }

    const scanName = scans.rows.find((s) => s.id === run.scanDefinitionId)?.name ?? shortId(run.scanDefinitionId);
    const c = run.counters;

    const stats: Array<[string, string]> = [
        ['Ziyaret Edilen Sayfa', formatNumber(c.pagesVisited)],
        ['Kategori Sayfası', formatNumber(c.categoryPagesVisited)],
        ['Detay Sayfası', formatNumber(c.detailPagesVisited)],
        ['Keşfedilen İlan', formatNumber(c.itemsDiscovered)],
        ['Eklenen', formatNumber(c.itemsInserted)],
        ['Güncellenen', formatNumber(c.itemsUpdated)],
        ['Fiyat Değişimi', formatNumber(c.pricesChanged)],
        ['Başarısız İstek', formatNumber(c.failedRequests)],
        ['Yeniden Deneme', formatNumber(c.retryCount)],
        ['Süre', formatDuration(run.durationMs)],
    ];

    return (
        <div className="space-y-4">
            <PageHeader
                title={`Run ${shortId(run.id)}`}
                description={`${formatDateTime(run.createdAt)} · ${scanName}`}
                actions={
                    <>
                        <Badge variant="outline">{RUN_TRIGGER_LABELS[run.trigger]}</Badge>
                        <Badge variant={RUN_STATUS_TONES[run.status]}>{RUN_STATUS_LABELS[run.status]}</Badge>
                        <RunActions run={run} />
                    </>
                }
            />

            <Card>
                <CardContent className="flex flex-wrap gap-x-6 gap-y-1 p-4 text-sm text-muted-foreground">
                    <span>
                        Tarama:{' '}
                        <Link href={`/taramalar/${run.scanDefinitionId}`} className="text-primary hover:underline">
                            {scanName}
                        </Link>
                    </span>
                    <span>Başlangıç: {formatDateTime(run.startedAt)}</span>
                    <span>Bitiş: {formatDateTime(run.finishedAt)}</span>
                </CardContent>
            </Card>

            {run.errorSummary !== null && run.errorSummary !== '' && (
                <Card className="border-destructive/40">
                    <CardHeader>
                        <CardTitle className="text-destructive">Hata Özeti</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm">{run.errorSummary}</p>
                    </CardContent>
                </Card>
            )}

            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                {stats.map(([label, value]) => (
                    <Card key={label} className="p-3">
                        <div className="text-xs text-muted-foreground">{label}</div>
                        <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
                    </Card>
                ))}
            </div>

            <RunEventLog runId={run.id} initialEvents={run.events} initialStatus={run.status} />

            <SnapshotViewer snapshot={run.configurationSnapshot} />
        </div>
    );
}
