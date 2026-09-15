'use client';

import { ChevronDown, MoreHorizontal, Pencil, Plus, Server, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { BulkImportDialog } from '@/components/proxies/bulk-import-dialog';
import { EndpointDialog } from '@/components/proxies/endpoint-dialog';
import { ProfileDialog } from '@/components/proxies/profile-dialog';
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
import { ApiError, apiDelete, apiPatch, apiPost } from '@/lib/api';
import { formatNumber, relativeTime } from '@/lib/format';
import { PROXY_HEALTH_LABELS, PROXY_HEALTH_TONES, PROXY_STRATEGY_LABELS } from '@/lib/labels';
import type { ProxyEndpointDto, ProxyHealth, ProxyProfileDetailDto, ProxyProfileSummaryDto } from '@/lib/types';
import { cn } from '@/lib/utils';

const HEALTH_ORDER: ProxyHealth[] = ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN', 'DISABLED'];

/**
 * NOTE (API gap): the API has no per-endpoint health-check route
 * (POST /api/proxy-endpoints/:id/health-check exists only in the architecture
 * doc), so no manual "check now" button is rendered — health values shown
 * here are the worker/maintenance-recorded ones.
 */
export function ProxyManager({
    profiles,
    details,
}: {
    profiles: ProxyProfileSummaryDto[];
    details: ProxyProfileDetailDto[];
}) {
    const router = useRouter();
    const [expandedId, setExpandedId] = useState<string | null>(details[0]?.id ?? null);
    const [profileDialog, setProfileDialog] = useState<{ open: boolean; profile?: ProxyProfileSummaryDto }>({
        open: false,
    });
    const [endpointDialogFor, setEndpointDialogFor] = useState<string | null>(null);
    const [bulkDialogFor, setBulkDialogFor] = useState<string | null>(null);
    const [deleteProfile, setDeleteProfile] = useState<ProxyProfileSummaryDto | null>(null);
    const [deleteEndpoint, setDeleteEndpoint] = useState<ProxyEndpointDto | null>(null);

    const endpointsOf = (profileId: string): ProxyEndpointDto[] =>
        details.find((d) => d.id === profileId)?.endpoints ?? [];

    const toggleProfile = async (profile: ProxyProfileSummaryDto, enabled: boolean) => {
        try {
            await apiPatch(`/api/proxy-profiles/${profile.id}`, { enabled });
            router.refresh();
        } catch (err) {
            toast.error('Durum değiştirilemedi', {
                description: err instanceof ApiError ? err.message : undefined,
            });
        }
    };

    const toggleEndpoint = async (endpoint: ProxyEndpointDto, enabled: boolean) => {
        try {
            await apiPost(`/api/proxy-endpoints/${endpoint.id}/toggle`, { enabled });
            router.refresh();
        } catch (err) {
            toast.error('Endpoint durumu değiştirilemedi', {
                description: err instanceof ApiError ? err.message : undefined,
            });
        }
    };

    const removeProfile = async (profile: ProxyProfileSummaryDto) => {
        try {
            await apiDelete(`/api/proxy-profiles/${profile.id}`);
            toast.success('Profil silindi', { description: profile.name });
            router.refresh();
        } catch (err) {
            toast.error('Silme başarısız', { description: err instanceof ApiError ? err.message : undefined });
            throw err;
        }
    };

    const removeEndpoint = async (endpoint: ProxyEndpointDto) => {
        try {
            await apiDelete(`/api/proxy-endpoints/${endpoint.id}`);
            toast.success('Endpoint silindi', { description: `${endpoint.host}:${endpoint.port}` });
            router.refresh();
        } catch (err) {
            toast.error('Silme başarısız', { description: err instanceof ApiError ? err.message : undefined });
            throw err;
        }
    };

    if (profiles.length === 0) {
        return (
            <>
                <EmptyState
                    icon={Server}
                    title="Henüz proxy profili yok"
                    description="Proxy profilleri Managed tarayıcı modunda kullanılır; CDP modunda kullanıcının kendi ağı geçerlidir."
                    action={
                        <Button size="sm" onClick={() => setProfileDialog({ open: true })}>
                            <Plus />
                            Profil Oluştur
                        </Button>
                    }
                />
                <ProfileDialog open={profileDialog.open} onOpenChange={(open) => setProfileDialog({ open })} />
            </>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <Button size="sm" onClick={() => setProfileDialog({ open: true })}>
                    <Plus />
                    Yeni Profil
                </Button>
            </div>

            {profiles.map((profile) => {
                const expanded = expandedId === profile.id;
                const endpoints = endpointsOf(profile.id);
                return (
                    <Card key={profile.id}>
                        <div className="flex flex-wrap items-center gap-3 p-4">
                            <button
                                type="button"
                                onClick={() => setExpandedId(expanded ? null : profile.id)}
                                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                                aria-expanded={expanded}
                            >
                                <ChevronDown
                                    className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
                                />
                                <span className="truncate font-medium">{profile.name}</span>
                                <Badge variant="outline">{PROXY_STRATEGY_LABELS[profile.strategy]}</Badge>
                                <span className="text-xs text-muted-foreground tabular-nums">
                                    {profile.enabledEndpointCount}/{profile.endpointCount} endpoint aktif
                                </span>
                            </button>
                            <div className="flex flex-wrap items-center gap-1.5">
                                {HEALTH_ORDER.filter((h) => profile.healthSummary[h.toLowerCase() as keyof typeof profile.healthSummary] > 0).map(
                                    (health) => (
                                        <Badge key={health} variant={PROXY_HEALTH_TONES[health]}>
                                            {PROXY_HEALTH_LABELS[health]}{' '}
                                            {profile.healthSummary[health.toLowerCase() as keyof typeof profile.healthSummary]}
                                        </Badge>
                                    ),
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <Switch
                                    checked={profile.enabled}
                                    onCheckedChange={(enabled) => void toggleProfile(profile, enabled)}
                                    aria-label="Profili aç/kapat"
                                />
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="icon-sm">
                                            <MoreHorizontal />
                                            <span className="sr-only">Profil aksiyonları</span>
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem onClick={() => setProfileDialog({ open: true, profile })}>
                                            <Pencil />
                                            Düzenle
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => setEndpointDialogFor(profile.id)}>
                                            <Plus />
                                            Endpoint Ekle
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => setBulkDialogFor(profile.id)}>
                                            <Upload />
                                            Toplu İçe Aktar
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            className="text-destructive focus:text-destructive"
                                            onClick={() => setDeleteProfile(profile)}
                                        >
                                            <Trash2 />
                                            Sil
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        </div>

                        {expanded && (
                            <CardContent className="border-t pt-3">
                                {endpoints.length === 0 ? (
                                    <div className="flex items-center justify-between gap-3 py-2">
                                        <p className="text-sm text-muted-foreground">Bu profilde endpoint yok.</p>
                                        <Button variant="outline" size="sm" onClick={() => setEndpointDialogFor(profile.id)}>
                                            <Plus />
                                            Endpoint Ekle
                                        </Button>
                                    </div>
                                ) : (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Endpoint</TableHead>
                                                <TableHead>Protokol</TableHead>
                                                <TableHead>Ülke</TableHead>
                                                <TableHead>Sağlık</TableHead>
                                                <TableHead className="text-right">Gecikme</TableHead>
                                                <TableHead className="text-right">Başarı / Hata</TableHead>
                                                <TableHead>Son Kontrol</TableHead>
                                                <TableHead>Aktif</TableHead>
                                                <TableHead className="w-[48px]" />
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {endpoints.map((endpoint) => (
                                                <TableRow key={endpoint.id}>
                                                    <TableCell>
                                                        <span className="font-mono text-xs">
                                                            {endpoint.host}:{endpoint.port}
                                                        </span>
                                                        {endpoint.name !== null && endpoint.name !== '' && (
                                                            <span className="block text-xs text-muted-foreground">
                                                                {endpoint.name}
                                                            </span>
                                                        )}
                                                        {endpoint.quarantinedUntil !== null &&
                                                            new Date(endpoint.quarantinedUntil) > new Date() && (
                                                                <span className="block text-xs text-warning">
                                                                    Karantinada — {relativeTime(endpoint.quarantinedUntil)} kadar
                                                                </span>
                                                            )}
                                                    </TableCell>
                                                    <TableCell className="text-xs">{endpoint.protocol}</TableCell>
                                                    <TableCell className="text-xs">{endpoint.country ?? '—'}</TableCell>
                                                    <TableCell>
                                                        <Badge variant={PROXY_HEALTH_TONES[endpoint.healthStatus]}>
                                                            {PROXY_HEALTH_LABELS[endpoint.healthStatus]}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        {endpoint.latencyMs !== null ? `${formatNumber(endpoint.latencyMs)} ms` : '—'}
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        <span className="text-success">{formatNumber(endpoint.successCount)}</span>
                                                        {' / '}
                                                        <span className={endpoint.failureCount > 0 ? 'text-destructive' : 'text-muted-foreground'}>
                                                            {formatNumber(endpoint.failureCount)}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                                        {relativeTime(endpoint.lastCheckedAt)}
                                                    </TableCell>
                                                    <TableCell>
                                                        <Switch
                                                            checked={endpoint.enabled}
                                                            onCheckedChange={(enabled) => void toggleEndpoint(endpoint, enabled)}
                                                            aria-label="Endpoint aç/kapat"
                                                        />
                                                    </TableCell>
                                                    <TableCell>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            onClick={() => setDeleteEndpoint(endpoint)}
                                                            aria-label="Endpoint sil"
                                                        >
                                                            <Trash2 className="text-destructive" />
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                )}
                            </CardContent>
                        )}
                    </Card>
                );
            })}

            <ProfileDialog
                open={profileDialog.open}
                onOpenChange={(open) => setProfileDialog(open ? profileDialog : { open: false })}
                profile={profileDialog.profile}
            />
            {endpointDialogFor !== null && (
                <EndpointDialog
                    open
                    onOpenChange={(open) => !open && setEndpointDialogFor(null)}
                    profileId={endpointDialogFor}
                />
            )}
            {bulkDialogFor !== null && (
                <BulkImportDialog
                    open
                    onOpenChange={(open) => !open && setBulkDialogFor(null)}
                    profileId={bulkDialogFor}
                />
            )}

            <ConfirmDialog
                open={deleteProfile !== null}
                onOpenChange={(open) => !open && setDeleteProfile(null)}
                title="Proxy profilini sil"
                description={
                    deleteProfile !== null
                        ? `"${deleteProfile.name}" ve ${deleteProfile.endpointCount} endpoint'i silinecek; kullanan taramalar 'Yok'a düşer.`
                        : undefined
                }
                confirmLabel="Sil"
                destructive
                onConfirm={async () => {
                    if (deleteProfile !== null) await removeProfile(deleteProfile);
                }}
            />
            <ConfirmDialog
                open={deleteEndpoint !== null}
                onOpenChange={(open) => !open && setDeleteEndpoint(null)}
                title="Endpoint'i sil"
                description={
                    deleteEndpoint !== null
                        ? `${deleteEndpoint.host}:${deleteEndpoint.port} silinecek. Bu işlem geri alınamaz.`
                        : undefined
                }
                confirmLabel="Sil"
                destructive
                onConfirm={async () => {
                    if (deleteEndpoint !== null) await removeEndpoint(deleteEndpoint);
                }}
            />
        </div>
    );
}
