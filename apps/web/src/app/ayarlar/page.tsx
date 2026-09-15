import type { Metadata } from 'next';

import { PageHeader } from '@/components/page-header';
import { SettingsForm } from '@/components/settings/settings-form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { API_URL, serverApiGet } from '@/lib/server-api';
import type { HealthResponse, SettingsMap } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Ayarlar' };

export default async function SettingsPage() {
    const settings = await serverApiGet<SettingsMap>('/api/settings');
    // Health is best-effort: the settings form must still render when the API
    // is degraded (the fetch above already succeeded if we're here).
    let health: HealthResponse | null = null;
    try {
        health = await serverApiGet<HealthResponse>('/health');
    } catch {
        health = null;
    }

    return (
        <div className="space-y-4">
            <PageHeader title="Ayarlar" description="Uygulama ayarları ve sistem durumu" />

            <div className="grid gap-4 xl:grid-cols-2">
                <SettingsForm settings={settings} />

                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Sistem Bilgisi</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">API Durumu</span>
                                {health !== null ? (
                                    <Badge variant={health.status === 'ok' ? 'success' : 'destructive'}>
                                        {health.status === 'ok' ? 'Çalışıyor' : 'Degrade'}
                                    </Badge>
                                ) : (
                                    <Badge variant="destructive">Erişilemiyor</Badge>
                                )}
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">PostgreSQL</span>
                                <Badge variant={health?.db === 'up' ? 'success' : 'destructive'}>
                                    {health?.db === 'up' ? 'Bağlı' : 'Kapalı'}
                                </Badge>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Redis</span>
                                <Badge variant={health?.redis === 'up' ? 'success' : 'destructive'}>
                                    {health?.redis === 'up' ? 'Bağlı' : 'Kapalı'}
                                </Badge>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">API Adresi</span>
                                <span className="font-mono text-xs">{API_URL}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Web Sürümü</span>
                                <span className="font-mono text-xs">0.1.0</span>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-destructive/40">
                        <CardHeader>
                            <CardTitle className="text-destructive">Tehlikeli Bölge</CardTitle>
                        </CardHeader>
                        <CardContent className="text-sm text-muted-foreground">
                            <p>
                                Veritabanı sıfırlama, toplu ilan silme ve gizli anahtar rotasyonu gibi yıkıcı
                                işlemler bu panelde sunulmaz; yalnızca CLI / API üzerinden bilinçli olarak
                                yapılır. Kayıt silme işlemleri (tarama, profil, politika) ilgili sayfalarda onay
                                ile yapılır.
                            </p>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
