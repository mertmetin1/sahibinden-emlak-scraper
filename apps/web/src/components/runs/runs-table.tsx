'use client';

import { CircleX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError, apiPost } from '@/lib/api';
import { formatDuration, formatNumber, relativeTime, shortId } from '@/lib/format';
import { API_ERROR_LABELS, RUN_STATUS_LABELS, RUN_STATUS_TONES, RUN_TRIGGER_LABELS } from '@/lib/labels';
import { ACTIVE_RUN_STATUSES, type RunDto } from '@/lib/types';

export function RunsTable({ rows, scanNames }: { rows: RunDto[]; scanNames: Map<string, string> }) {
    const router = useRouter();
    const [cancelTarget, setCancelTarget] = useState<RunDto | null>(null);

    const cancel = async (run: RunDto) => {
        try {
            await apiPost(`/api/runs/${run.id}/cancel`);
            toast.success('İptal isteği gönderildi', { description: `Run ${shortId(run.id)}` });
            router.refresh();
        } catch (err) {
            toast.error(API_ERROR_LABELS[err instanceof ApiError ? err.code : ''] ?? 'İptal başarısız', {
                description: err instanceof Error ? err.message : undefined,
            });
            throw err;
        }
    };

    return (
        <>
            <div className="rounded-lg border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Run</TableHead>
                            <TableHead>Tarama</TableHead>
                            <TableHead>Tetik</TableHead>
                            <TableHead>Durum</TableHead>
                            <TableHead>Başlangıç</TableHead>
                            <TableHead className="text-right">Süre</TableHead>
                            <TableHead className="text-right">Keşf.</TableHead>
                            <TableHead className="text-right">Eklenen</TableHead>
                            <TableHead className="text-right">Günc.</TableHead>
                            <TableHead className="text-right">Fiyat Değ.</TableHead>
                            <TableHead className="text-right">Hata</TableHead>
                            <TableHead className="w-[48px]" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((run) => {
                            const active = ACTIVE_RUN_STATUSES.includes(run.status);
                            return (
                                <TableRow
                                    key={run.id}
                                    className="cursor-pointer"
                                    onClick={() => router.push(`/calistirmalar/${run.id}`)}
                                >
                                    <TableCell className="font-mono text-xs text-muted-foreground">
                                        {shortId(run.id)}
                                    </TableCell>
                                    <TableCell className="max-w-[200px]">
                                        <span className="block truncate font-medium">
                                            {scanNames.get(run.scanDefinitionId) ?? shortId(run.scanDefinitionId)}
                                        </span>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant="outline">{RUN_TRIGGER_LABELS[run.trigger]}</Badge>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant={RUN_STATUS_TONES[run.status]}>
                                            {RUN_STATUS_LABELS[run.status]}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap text-muted-foreground">
                                        {relativeTime(run.startedAt ?? run.createdAt)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatDuration(run.durationMs)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(run.counters.itemsDiscovered)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(run.counters.itemsInserted)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(run.counters.itemsUpdated)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(run.counters.pricesChanged)}
                                    </TableCell>
                                    <TableCell
                                        className={
                                            run.counters.failedRequests > 0
                                                ? 'text-right font-medium tabular-nums text-destructive'
                                                : 'text-right tabular-nums text-muted-foreground'
                                        }
                                    >
                                        {formatNumber(run.counters.failedRequests)}
                                    </TableCell>
                                    <TableCell onClick={(e) => e.stopPropagation()}>
                                        {active && (
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => setCancelTarget(run)}
                                                aria-label="İptal et"
                                                title="İptal et"
                                            >
                                                <CircleX className="text-destructive" />
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>

            <ConfirmDialog
                open={cancelTarget !== null}
                onOpenChange={(open) => !open && setCancelTarget(null)}
                title="Çalıştırmayı iptal et"
                description={
                    cancelTarget !== null
                        ? `Run ${shortId(cancelTarget.id)} kooperatif olarak durdurulur.`
                        : undefined
                }
                confirmLabel="İptal Et"
                destructive
                onConfirm={async () => {
                    if (cancelTarget !== null) await cancel(cancelTarget);
                }}
            />
        </>
    );
}
