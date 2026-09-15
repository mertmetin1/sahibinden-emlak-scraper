import { Activity, AlertTriangle, Building2, CalendarClock, Home, Play, Radar, TrendingUp } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDuration, formatNumber, relativeTime } from '@/lib/format';
import { PROXY_HEALTH_LABELS, RUN_STATUS_LABELS, RUN_STATUS_TONES } from '@/lib/labels';
import { serverApiGet } from '@/lib/server-api';
import type { DashboardSummary, ProxyHealth } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
    const data = await serverApiGet<DashboardSummary>('/api/dashboard');

    const healthEntries = (
        ['healthy', 'degraded', 'unhealthy', 'unknown', 'disabled'] as const
    ).map((key) => ({ key, count: data.proxyHealthSummary[key] }));

    return (
        <div className="space-y-4">
            <PageHeader
                title="Dashboard"
                description="Operasyon özeti — tüm sayılar canlı API verisinden"
                actions={
                    <Button asChild size="sm">
                        <Link href="/taramalar">
                            <Radar />
                            Taramalar
                        </Link>
                    </Button>
                }
            />

            {data.totalListings === 0 && data.activeScans === 0 ? (
                <EmptyState
                    icon={Home}
                    title="Henüz veri yok"
                    description="İlan görmek için önce bir tarama tanımı oluşturup çalıştırın."
                    action={
                        <Button asChild size="sm">
                            <Link href="/taramalar/new">İlk Taramayı Oluştur</Link>
                        </Button>
                    }
                />
            ) : null}

            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                <StatCard label="Toplam İlan" value={formatNumber(data.totalListings)} icon={Home} />
                <StatCard
                    label="Bugün Yeni"
                    value={formatNumber(data.newListingsToday)}
                    icon={CalendarClock}
                    tone={data.newListingsToday > 0 ? 'success' : 'default'}
                />
                <StatCard label="Bugün Güncellenen" value={formatNumber(data.updatedListingsToday)} icon={Activity} />
                <StatCard
                    label="Bugün Fiyat Değişimi"
                    value={formatNumber(data.priceChangesToday)}
                    icon={TrendingUp}
                    tone={data.priceChangesToday > 0 ? 'warning' : 'default'}
                />
                <StatCard
                    label="Satıcı Kırılımı"
                    value={`${formatNumber(data.ownerListings)} / ${formatNumber(data.officeListings)}`}
                    sub="Sahibinden / Ofis"
                    icon={Building2}
                />
                <StatCard label="Aktif Tarama" value={formatNumber(data.activeScans)} icon={Radar} />
                <StatCard
                    label="Çalışan Run"
                    value={formatNumber(data.runningRuns)}
                    icon={Play}
                    tone={data.runningRuns > 0 ? 'info' : 'default'}
                />
                <StatCard
                    label="24s Başarısız Run"
                    value={formatNumber(data.failedRuns24h)}
                    icon={AlertTriangle}
                    tone={data.failedRuns24h > 0 ? 'destructive' : 'default'}
                />
                <StatCard label="Güncel Olmayan İlan" value={formatNumber(data.staleListings)} sub="stale" />
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
                <Card className="xl:col-span-2">
                    <CardHeader className="flex-row items-center justify-between">
                        <CardTitle>Son Çalıştırmalar</CardTitle>
                        <Button asChild variant="ghost" size="sm">
                            <Link href="/calistirmalar">Tümü</Link>
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {data.recentRuns.length === 0 ? (
                            <p className="py-6 text-center text-sm text-muted-foreground">
                                Henüz çalıştırma yok — bir taramayı manuel başlatabilirsiniz.
                            </p>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Tarama</TableHead>
                                        <TableHead>Durum</TableHead>
                                        <TableHead className="text-right">Süre</TableHead>
                                        <TableHead className="text-right">Eklenen</TableHead>
                                        <TableHead className="text-right">Başlangıç</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {data.recentRuns.map((run) => (
                                        <TableRow key={run.id}>
                                            <TableCell className="max-w-[220px]">
                                                <Link
                                                    href={`/calistirmalar/${run.id}`}
                                                    className="block truncate font-medium text-primary hover:underline"
                                                >
                                                    {run.scanName}
                                                </Link>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant={RUN_STATUS_TONES[run.status]}>
                                                    {RUN_STATUS_LABELS[run.status]}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                {formatDuration(run.durationMs)}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                {formatNumber(run.itemsInserted)}
                                            </TableCell>
                                            <TableCell className="text-right text-muted-foreground">
                                                {relativeTime(run.startedAt)}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex-row items-center justify-between">
                        <CardTitle>Proxy Sağlığı</CardTitle>
                        <Button asChild variant="ghost" size="sm">
                            <Link href="/proxyler">Yönet</Link>
                        </Button>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {healthEntries.every((e) => e.count === 0) ? (
                            <p className="py-2 text-sm text-muted-foreground">
                                Tanımlı proxy endpoint&apos;i yok.
                            </p>
                        ) : (
                            healthEntries.map((entry) => (
                                <div key={entry.key} className="flex items-center justify-between text-sm">
                                    <span className="text-muted-foreground">
                                        {PROXY_HEALTH_LABELS[entry.key.toUpperCase() as ProxyHealth] ?? entry.key}
                                    </span>
                                    <span className="font-medium tabular-nums">{formatNumber(entry.count)}</span>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
