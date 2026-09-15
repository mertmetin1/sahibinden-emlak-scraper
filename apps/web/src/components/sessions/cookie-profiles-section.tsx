'use client';

import { Cookie, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { CookieImportDialog } from '@/components/sessions/cookie-import-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { formatNumber, relativeTime } from '@/lib/format';
import { COOKIE_VALIDATION_LABELS, COOKIE_VALIDATION_TONES } from '@/lib/labels';
import type { CookieProfileDto } from '@/lib/types';

/** Cookie profiles — metadata only; cookie values are never rendered anywhere. */
export function CookieProfilesSection({ profiles }: { profiles: CookieProfileDto[] }) {
    const router = useRouter();
    const [importOpen, setImportOpen] = useState(false);
    const [replaceTarget, setReplaceTarget] = useState<CookieProfileDto | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<CookieProfileDto | null>(null);

    const toggle = async (profile: CookieProfileDto, enabled: boolean) => {
        try {
            await apiPost(`/api/cookie-profiles/${profile.id}/toggle`, { enabled });
            router.refresh();
        } catch (err) {
            toast.error('Durum değiştirilemedi', {
                description: err instanceof ApiError ? err.message : undefined,
            });
        }
    };

    const remove = async (profile: CookieProfileDto) => {
        try {
            await apiDelete(`/api/cookie-profiles/${profile.id}`);
            toast.success('Çerez profili silindi', { description: profile.name });
            router.refresh();
        } catch (err) {
            toast.error('Silme başarısız', { description: err instanceof ApiError ? err.message : undefined });
            throw err;
        }
    };

    return (
        <section className="space-y-3">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Çerez Profilleri</h2>
                <Button size="sm" onClick={() => setImportOpen(true)}>
                    <Plus />
                    Çerez İçe Aktar
                </Button>
            </div>

            {profiles.length === 0 ? (
                <EmptyState
                    icon={Cookie}
                    title="Çerez profili yok"
                    description="sahibinden.com oturum çerezlerinizi içe aktararak tarayıcının sizin oturumunuzla çalışmasını sağlayın."
                    action={
                        <Button size="sm" onClick={() => setImportOpen(true)}>
                            <Plus />
                            İlk Profili İçe Aktar
                        </Button>
                    }
                />
            ) : (
                <Card>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Ad</TableHead>
                                    <TableHead>Aktif</TableHead>
                                    <TableHead className="text-right">Çerez</TableHead>
                                    <TableHead>Alan Adları</TableHead>
                                    <TableHead>Süre</TableHead>
                                    <TableHead>Doğrulama</TableHead>
                                    <TableHead>Son Doğrulama</TableHead>
                                    <TableHead className="text-right">Tarama</TableHead>
                                    <TableHead className="w-[48px]" />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {profiles.map((profile) => (
                                    <TableRow key={profile.id}>
                                        <TableCell>
                                            <span className="font-medium">{profile.name}</span>
                                            {profile.notes !== '' && (
                                                <span
                                                    className="block max-w-[220px] truncate text-xs text-muted-foreground"
                                                    title={profile.notes}
                                                >
                                                    {profile.notes}
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <Switch
                                                checked={profile.enabled}
                                                onCheckedChange={(enabled) => void toggle(profile, enabled)}
                                                aria-label="Profili aç/kapat"
                                            />
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {formatNumber(profile.cookieCount)}
                                        </TableCell>
                                        <TableCell className="max-w-[200px]">
                                            <span className="block truncate text-xs" title={profile.domainSummary}>
                                                {profile.domainSummary !== '' ? profile.domainSummary : '—'}
                                            </span>
                                        </TableCell>
                                        <TableCell className="max-w-[160px]">
                                            <span className="block truncate text-xs" title={profile.expirySummary}>
                                                {profile.expirySummary !== '' ? profile.expirySummary : '—'}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={COOKIE_VALIDATION_TONES[profile.validationStatus]}>
                                                {COOKIE_VALIDATION_LABELS[profile.validationStatus]}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                            {relativeTime(profile.lastValidatedAt)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {formatNumber(profile.assignedScanCount)}
                                        </TableCell>
                                        <TableCell>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon-sm">
                                                        <MoreHorizontal />
                                                        <span className="sr-only">Aksiyonlar</span>
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuItem onClick={() => setReplaceTarget(profile)}>
                                                        <RefreshCw />
                                                        Çerezleri Değiştir
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem
                                                        className="text-destructive focus:text-destructive"
                                                        onClick={() => setDeleteTarget(profile)}
                                                    >
                                                        <Trash2 />
                                                        Sil
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            <CookieImportDialog open={importOpen} onOpenChange={setImportOpen} mode="import" />
            {replaceTarget !== null && (
                <CookieImportDialog
                    open
                    onOpenChange={(open) => !open && setReplaceTarget(null)}
                    mode="replace"
                    profileId={replaceTarget.id}
                    profileName={replaceTarget.name}
                />
            )}
            <ConfirmDialog
                open={deleteTarget !== null}
                onOpenChange={(open) => !open && setDeleteTarget(null)}
                title="Çerez profilini sil"
                description={
                    deleteTarget !== null
                        ? `"${deleteTarget.name}" silinecek; kullanan ${deleteTarget.assignedScanCount} tarama 'Yok'a düşer.`
                        : undefined
                }
                confirmLabel="Sil"
                destructive
                onConfirm={async () => {
                    if (deleteTarget !== null) await remove(deleteTarget);
                }}
            />
        </section>
    );
}
