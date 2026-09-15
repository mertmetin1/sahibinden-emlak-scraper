'use client';

import { Copy, FlaskConical, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError, apiDelete, apiPost } from '@/lib/api';
import { cronPreview } from '@/lib/cron';
import { relativeTime } from '@/lib/format';
import { API_ERROR_LABELS, RUN_STATUS_LABELS, RUN_STATUS_TONES } from '@/lib/labels';
import type { RunDto, ScanWithLatestRun } from '@/lib/types';

function toastApiError(err: unknown, fallback: string) {
    if (err instanceof ApiError) {
        toast.error(API_ERROR_LABELS[err.code] ?? fallback, { description: err.message });
    } else {
        toast.error(fallback);
    }
}

export function ScansTable({ rows }: { rows: ScanWithLatestRun[] }) {
    const router = useRouter();
    const [deleteTarget, setDeleteTarget] = useState<ScanWithLatestRun | null>(null);
    // Per-row pending flags so double-clicks can't double-fire.
    const [pending, setPending] = useState<Record<string, string | undefined>>({});

    const mark = (id: string, action: string | undefined) =>
        setPending((prev) => ({ ...prev, [id]: action }));

    const runAction = async (scan: ScanWithLatestRun, action: 'run' | 'test') => {
        mark(scan.id, action);
        try {
            const run = await apiPost<RunDto>(`/api/scans/${scan.id}/${action}`);
            toast.success(action === 'run' ? 'Çalıştırma kuyruğa alındı' : 'Test çalıştırması başlatıldı', {
                description: `Run ${run.id.slice(0, 8)}`,
                action: {
                    label: 'İzle',
                    onClick: () => router.push(`/calistirmalar/${run.id}`),
                },
            });
            router.refresh();
        } catch (err) {
            toastApiError(err, 'Çalıştırma başlatılamadı');
        } finally {
            mark(scan.id, undefined);
        }
    };

    const toggle = async (scan: ScanWithLatestRun, enabled: boolean) => {
        mark(scan.id, 'toggle');
        try {
            await apiPost(`/api/scans/${scan.id}/toggle`, { enabled });
            toast.success(enabled ? 'Tarama aktifleştirildi' : 'Tarama devre dışı bırakıldı');
            router.refresh();
        } catch (err) {
            toastApiError(err, 'Durum değiştirilemedi');
        } finally {
            mark(scan.id, undefined);
        }
    };

    const duplicate = async (scan: ScanWithLatestRun) => {
        mark(scan.id, 'duplicate');
        try {
            const copy = await apiPost<ScanWithLatestRun>(`/api/scans/${scan.id}/duplicate`);
            toast.success('Tarama çoğaltıldı', { description: `"${copy.name}" (devre dışı oluşturuldu)` });
            router.refresh();
        } catch (err) {
            toastApiError(err, 'Çoğaltma başarısız');
        } finally {
            mark(scan.id, undefined);
        }
    };

    const remove = async (scan: ScanWithLatestRun) => {
        try {
            await apiDelete(`/api/scans/${scan.id}`);
            toast.success('Tarama silindi', { description: scan.name });
            router.refresh();
        } catch (err) {
            toastApiError(err, 'Silme başarısız');
            // Surface the failure to the caller so the dialog stays honest.
            throw err;
        }
    };

    return (
        <>
            <div className="rounded-lg border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Ad</TableHead>
                            <TableHead>Durum</TableHead>
                            <TableHead className="text-right">Hedef URL</TableHead>
                            <TableHead>Zamanlama</TableHead>
                            <TableHead>Son Run</TableHead>
                            <TableHead className="w-[56px] text-right">Aksiyon</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((scan) => {
                            const busy = pending[scan.id] !== undefined;
                            return (
                                <TableRow key={scan.id}>
                                    <TableCell className="max-w-[260px]">
                                        <Link
                                            href={`/taramalar/${scan.id}`}
                                            className="block truncate font-medium text-primary hover:underline"
                                        >
                                            {scan.name}
                                        </Link>
                                        {scan.description !== '' && (
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {scan.description}
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex items-center gap-2">
                                            <Switch
                                                checked={scan.enabled}
                                                disabled={busy}
                                                onCheckedChange={(enabled) => void toggle(scan, enabled)}
                                                aria-label={scan.enabled ? 'Devre dışı bırak' : 'Aktifleştir'}
                                            />
                                            <span className="text-xs text-muted-foreground">
                                                {scan.enabled ? 'Aktif' : 'Pasif'}
                                            </span>
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">{scan.startUrls.length}</TableCell>
                                    <TableCell>
                                        <div className="text-sm">{cronPreview(scan.schedule)}</div>
                                        <div className="text-xs text-muted-foreground">{scan.timezone}</div>
                                    </TableCell>
                                    <TableCell>
                                        {scan.latestRun !== null ? (
                                            <div className="flex items-center gap-2">
                                                <Badge variant={RUN_STATUS_TONES[scan.latestRun.status]}>
                                                    {RUN_STATUS_LABELS[scan.latestRun.status]}
                                                </Badge>
                                                <Link
                                                    href={`/calistirmalar/${scan.latestRun.id}`}
                                                    className="text-xs text-muted-foreground hover:text-foreground"
                                                >
                                                    {relativeTime(scan.latestRun.createdAt)}
                                                </Link>
                                            </div>
                                        ) : (
                                            <span className="text-sm text-muted-foreground">—</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button variant="ghost" size="icon-sm" disabled={busy}>
                                                    <MoreHorizontal />
                                                    <span className="sr-only">Aksiyonlar</span>
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem
                                                    disabled={!scan.enabled}
                                                    onClick={() => void runAction(scan, 'run')}
                                                >
                                                    <Play />
                                                    Çalıştır
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    disabled={!scan.enabled}
                                                    onClick={() => void runAction(scan, 'test')}
                                                >
                                                    <FlaskConical />
                                                    Test Et
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => router.push(`/taramalar/${scan.id}`)}>
                                                    <Pencil />
                                                    Düzenle
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => void duplicate(scan)}>
                                                    <Copy />
                                                    Çoğalt
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    className="text-destructive focus:text-destructive"
                                                    onClick={() => setDeleteTarget(scan)}
                                                >
                                                    <Trash2 />
                                                    Sil
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>

            <ConfirmDialog
                open={deleteTarget !== null}
                onOpenChange={(open) => !open && setDeleteTarget(null)}
                title="Taramayı sil"
                description={
                    deleteTarget !== null
                        ? `"${deleteTarget.name}" ve tüm çalıştırma geçmişi silinecek. Bu işlem geri alınamaz.`
                        : undefined
                }
                confirmLabel="Sil"
                destructive
                onConfirm={async () => {
                    if (deleteTarget !== null) await remove(deleteTarget);
                }}
            />
        </>
    );
}
