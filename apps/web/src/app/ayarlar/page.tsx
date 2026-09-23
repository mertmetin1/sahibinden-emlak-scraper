import type { Metadata } from 'next';

import { PageHeader } from '@/components/page-header';
import { SettingsForm } from '@/components/settings/settings-form';
import { StackStatus } from '@/components/settings/stack-status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { API_URL, serverApiGet } from '@/lib/server-api';
import type { SettingsMap } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Ayarlar' };

export default async function SettingsPage() {
    const settings = await serverApiGet<SettingsMap>('/api/settings');

    return (
        <div className="space-y-4">
            <PageHeader title="Ayarlar" description="Uygulama ayarları ve sistem durumu" />

            <div className="grid gap-4 xl:grid-cols-2">
                <SettingsForm settings={settings} />

                <div className="space-y-4">
                    <StackStatus apiUrl={API_URL} />

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
