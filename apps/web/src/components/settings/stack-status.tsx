'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiGet, apiPost } from '@/lib/api';
import type { HealthResponse, StackStatusResponse } from '@/lib/types';

const POLL_MS = 8_000;

function StatusBadge({ up }: { up: boolean }) {
    return <Badge variant={up ? 'success' : 'destructive'}>{up ? 'Çalışıyor' : 'Kapalı'}</Badge>;
}

/**
 * Live stack status on Ayarlar: db / redis / worker / LAN URLs, plus stop
 * when the panel was launched from the desktop shortcut.
 */
export function StackStatus({ apiUrl }: { apiUrl: string }) {
    const [health, setHealth] = useState<HealthResponse | null>(null);
    const [stack, setStack] = useState<StackStatusResponse | null>(null);
    const [healthError, setHealthError] = useState(false);
    const [stopOpen, setStopOpen] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const res = await fetch('/health', { cache: 'no-store' });
            const body = (await res.json()) as HealthResponse;
            setHealth(body);
            setHealthError(false);
        } catch {
            setHealth(null);
            setHealthError(true);
        }
        try {
            setStack(await apiGet<StackStatusResponse>('/api/stack'));
        } catch {
            setStack(null);
        }
    }, []);

    useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), POLL_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    const stopStack = async () => {
        try {
            const result = await apiPost<{ ok: boolean; desktopStack: boolean }>('/api/stack/stop');
            if (result.desktopStack) {
                toast.success('Kapatma isteği gönderildi', {
                    description: 'Kısayol penceresi API, worker ve paneli durduracak.',
                });
            } else {
                toast.success('Kapatma dosyası yazıldı', {
                    description:
                        'Bu süreç masaüstü kısayolundan açılmadı. Cursor terminallerini veya masaüstü kısayol penceresini kapatın.',
                });
            }
        } catch (err) {
            toast.error('Kapatılamadı', {
                description: err instanceof ApiError ? err.message : 'İstek başarısız',
            });
            throw err;
        }
    };

    const workerUp = (health?.worker ?? stack?.worker) === 'up';

    return (
        <>
            <Card>
                <CardHeader>
                    <CardTitle>Sistem Bilgisi</CardTitle>
                    <CardDescription>8 sn’de bir yenilenir. Worker nabzı Redis üzerinden okunur.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">API Durumu</span>
                        {healthError ? (
                            <Badge variant="destructive">Erişilemiyor</Badge>
                        ) : health !== null ? (
                            <Badge variant={health.status === 'ok' ? 'success' : 'destructive'}>
                                {health.status === 'ok' ? 'Çalışıyor' : 'Degrade'}
                            </Badge>
                        ) : (
                            <Badge variant="outline">…</Badge>
                        )}
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Worker</span>
                        <StatusBadge up={workerUp} />
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">PostgreSQL</span>
                        <StatusBadge up={health?.db === 'up'} />
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Redis</span>
                        <StatusBadge up={health?.redis === 'up'} />
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">API Adresi</span>
                        <span className="font-mono text-xs">{apiUrl}</span>
                    </div>
                    {stack !== null && stack.lanUrls.length > 0 && (
                        <div className="space-y-1 pt-2">
                            <span className="text-muted-foreground">Lokal ağ</span>
                            <ul className="space-y-1">
                                {stack.lanUrls.map((url) => (
                                    <li key={url}>
                                        <a href={url} className="font-mono text-xs text-primary underline-offset-4 hover:underline">
                                            {url}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <div className="pt-3">
                        <Button variant="destructive" size="sm" onClick={() => setStopOpen(true)}>
                            Paneli ve worker’ı durdur
                        </Button>
                        {!stack?.desktopStack && (
                            <p className="mt-2 text-xs text-muted-foreground">
                                Kısayoldan başlatıldıysa bu düğme her şeyi kapatır. Cursor’dan açıldıysa ilgili
                                terminalleri elle kapatın.
                            </p>
                        )}
                    </div>
                </CardContent>
            </Card>
            <ConfirmDialog
                open={stopOpen}
                onOpenChange={setStopOpen}
                title="Stack durdurulsun mu?"
                description="API, worker ve web paneli kapanır. Açık bir tarama varsa worker kapanırken iptal etmeye çalışır."
                confirmLabel="Durdur"
                destructive
                onConfirm={stopStack}
            />
        </>
    );
}
