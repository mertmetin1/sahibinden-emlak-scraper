import { ExternalLink, Phone } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Gallery } from '@/components/listing-detail/gallery';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
    formatDate,
    formatDateTime,
    formatNumber,
    formatPrice,
    formatPriceChange,
    relativeTime,
    shortId,
} from '@/lib/format';
import {
    LISTING_OUTCOME_LABELS,
    LISTING_OUTCOME_TONES,
    LISTING_STATUS_LABELS,
    LISTING_STATUS_TONES,
    LISTING_TYPE_LABELS,
    RUN_STATUS_LABELS,
    RUN_STATUS_TONES,
    SELLER_TYPE_LABELS,
    SELLER_TYPE_TONES,
} from '@/lib/labels';
import { ServerApiError, serverApiGet } from '@/lib/server-api';
import type { ListingDetailDto, PriceHistoryResponse, SellerType } from '@/lib/types';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'İlan Detayı' };

interface PageProps {
    params: Promise<{ id: string }>;
}

/** Normalized feature grid rows — only rendered when the value exists. */
function featureRows(listing: ListingDetailDto): Array<[string, string]> {
    const rows: Array<[string, string | null | undefined]> = [
        ['İlan Tipi', listing.listingType !== null ? (LISTING_TYPE_LABELS[listing.listingType] ?? listing.listingType) : null],
        ['Mülk Tipi', [listing.propertyCategory, listing.propertySubtype].filter(Boolean).join(' / ') || null],
        ['Oda Sayısı', listing.rooms],
        ['m² (Brüt)', listing.grossAreaM2 !== null ? `${formatNumber(listing.grossAreaM2)} m²` : null],
        ['m² (Net)', listing.netAreaM2 !== null ? `${formatNumber(listing.netAreaM2)} m²` : null],
        ['Bina Yaşı', listing.buildingAge],
        ['Bulunduğu Kat', listing.floor],
        ['Kat Sayısı', listing.totalFloors],
        ['Isıtma', listing.heating],
        ['Banyo Sayısı', listing.bathroomCount],
        ['Balkon', listing.balcony],
        ['Eşyalı', listing.furnished],
        ['Kullanım Durumu', listing.usageStatus],
        [
            'Site İçerisinde',
            listing.insideSite !== null
                ? listing.siteName !== null && listing.siteName !== ''
                    ? `${listing.insideSite} (${listing.siteName})`
                    : listing.insideSite
                : null,
        ],
        ['Aidat', listing.dues],
        ['Depozito', listing.deposit],
        ['Tapu Durumu', listing.deedStatus],
        ['Krediye Uygun', listing.creditEligible],
        ['Takas', listing.exchangeEligible],
        ['İlan Tarihi', listing.listingDateRaw ?? (listing.listingDate !== null ? formatDate(listing.listingDate) : null)],
        ['Güncelleme Tarihi', listing.updatedDateRaw ?? (listing.updatedDate !== null ? formatDate(listing.updatedDate) : null)],
    ];
    return rows.filter((row): row is [string, string] => row[1] !== null && row[1] !== undefined && row[1] !== '');
}

export default async function ListingDetailPage({ params }: PageProps) {
    const { id } = await params;

    let listing: ListingDetailDto;
    let priceHistory: PriceHistoryResponse;
    try {
        [listing, priceHistory] = await Promise.all([
            serverApiGet<ListingDetailDto>(`/api/listings/${id}`),
            serverApiGet<PriceHistoryResponse>(`/api/listings/${id}/price-history`),
        ]);
    } catch (err) {
        if (err instanceof ServerApiError && err.status === 404) notFound();
        throw err;
    }

    const sellerType = (listing.seller?.type ?? listing.sellerType ?? 'UNKNOWN') as SellerType;
    const sellerName = listing.seller?.displayName ?? listing.seller?.officeName ?? null;
    const phone = listing.seller?.publicContactPhone ?? listing.publicContactPhone;
    const features = featureRows(listing);
    const location = [listing.province, listing.district, listing.neighborhood]
        .filter((p): p is string => p !== null && p !== '')
        .join(' / ');

    // API returns ascending points; display newest first with step deltas.
    const historyDesc = [...priceHistory.points].reverse();

    return (
        <div className="space-y-4">
            <PageHeader
                title={listing.title}
                description={`İlan No: ${listing.sourceListingId}${location !== '' ? ` · ${location}` : ''}`}
                actions={
                    <>
                        <Badge variant={LISTING_STATUS_TONES[listing.status]}>{LISTING_STATUS_LABELS[listing.status]}</Badge>
                        <Button asChild variant="outline" size="sm">
                            <a href={listing.canonicalUrl} target="_blank" rel="noreferrer">
                                <ExternalLink />
                                Kaynak İlan
                            </a>
                        </Button>
                    </>
                }
            />

            <div className="grid gap-4 xl:grid-cols-3">
                <div className="space-y-4 xl:col-span-2">
                    <Card>
                        <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-1 p-4">
                            <span className="text-2xl font-semibold tabular-nums">
                                {formatPrice(listing.price, listing.currency)}
                            </span>
                            {listing.pricePerSquareMeter !== null && (
                                <span className="text-sm text-muted-foreground tabular-nums">
                                    {formatNumber(listing.pricePerSquareMeter)} TL/m²
                                </span>
                            )}
                            {priceHistory.summary.totalChangePercent !== null && (
                                <PriceChangePill percent={priceHistory.summary.totalChangePercent} />
                            )}
                        </CardContent>
                    </Card>

                    <Gallery images={listing.images} />

                    <Card>
                        <CardHeader>
                            <CardTitle>Açıklama</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {listing.description !== '' ? (
                                <p className="whitespace-pre-wrap text-sm leading-relaxed">{listing.description}</p>
                            ) : (
                                <p className="text-sm text-muted-foreground">Açıklama yok.</p>
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Ham Özellikler</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {listing.attributes.length === 0 ? (
                                <p className="text-sm text-muted-foreground">Özellik kaydı yok.</p>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-[240px]">Özellik</TableHead>
                                            <TableHead>Değer</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {listing.attributes.map((attr) => (
                                            <TableRow key={attr.id}>
                                                <TableCell className="text-muted-foreground">{attr.key}</TableCell>
                                                <TableCell>{attr.value}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
                </div>

                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Satıcı</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            <div className="flex items-center gap-2">
                                <Badge variant={SELLER_TYPE_TONES[sellerType]}>{SELLER_TYPE_LABELS[sellerType]}</Badge>
                            </div>
                            {sellerName !== null && <div className="font-medium">{sellerName}</div>}
                            {listing.seller?.officeName !== null && listing.seller?.officeName !== undefined && (
                                <div className="text-muted-foreground">{listing.seller.officeName}</div>
                            )}
                            {listing.seller?.typeEvidence !== null &&
                                listing.seller?.typeEvidence !== undefined && (
                                    <div className="text-xs text-muted-foreground">
                                        Kanıt: {listing.seller.typeEvidence}
                                    </div>
                                )}
                            {/* Phone is shown only when the API has it (never a "gizli" placeholder). */}
                            {phone !== null && phone !== '' && (
                                <div className="flex items-center gap-1.5 pt-1 font-medium">
                                    <Phone className="size-3.5" />
                                    {phone}
                                </div>
                            )}
                            {listing.seller?.profileUrl !== null && listing.seller?.profileUrl !== undefined && (
                                <Button asChild variant="outline" size="sm" className="mt-1">
                                    <a href={listing.seller.profileUrl} target="_blank" rel="noreferrer">
                                        <ExternalLink />
                                        Satıcı Profili
                                    </a>
                                </Button>
                            )}
                        </CardContent>
                    </Card>

                    {features.length > 0 && (
                        <Card>
                            <CardHeader>
                                <CardTitle>Özellikler</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                    {features.map(([label, value]) => (
                                        <div key={label} className="min-w-0">
                                            <dt className="text-xs text-muted-foreground">{label}</dt>
                                            <dd className="truncate font-medium" title={value}>
                                                {value}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            </CardContent>
                        </Card>
                    )}

                    <Card>
                        <CardHeader>
                            <CardTitle>Fiyat Geçmişi</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {historyDesc.length === 0 ? (
                                <p className="text-sm text-muted-foreground">Fiyat değişimi kaydedilmedi.</p>
                            ) : (
                                <div className="space-y-2">
                                    <div className="text-xs text-muted-foreground">
                                        {priceHistory.summary.changeCount} değişim
                                        {priceHistory.summary.totalChangePercent !== null &&
                                            ` · toplam %${formatNumber(priceHistory.summary.totalChangePercent)}`}
                                    </div>
                                    <ul className="space-y-1.5">
                                        {historyDesc.map((point, index) => {
                                            const prev = historyDesc[index + 1];
                                            const step =
                                                prev !== undefined && prev.price !== 0
                                                    ? formatPriceChange(
                                                          Math.round(((point.price - prev.price) / prev.price) * 10000) / 100,
                                                      )
                                                    : null;
                                            return (
                                                <li
                                                    key={`${point.changedAt}-${index}`}
                                                    className="flex items-center justify-between gap-2 text-sm"
                                                >
                                                    <span className="text-muted-foreground">
                                                        {formatDateTime(point.changedAt)}
                                                    </span>
                                                    <span className="flex items-center gap-2">
                                                        {step !== null && (
                                                            <span
                                                                className={cn(
                                                                    'text-xs tabular-nums',
                                                                    step.direction === 'up' && 'text-destructive',
                                                                    step.direction === 'down' && 'text-success',
                                                                )}
                                                            >
                                                                {step.text}
                                                            </span>
                                                        )}
                                                        <span className="font-medium tabular-nums">
                                                            {formatPrice(point.price, point.currency)}
                                                        </span>
                                                    </span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>Gözlem Geçmişi (son {listing.seenHistory.length})</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {listing.seenHistory.length === 0 ? (
                            <p className="text-sm text-muted-foreground">Gözlem kaydı yok.</p>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Zaman</TableHead>
                                        <TableHead>Run</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {listing.seenHistory.map((seen) => (
                                        <TableRow key={seen.id}>
                                            <TableCell className="text-muted-foreground">
                                                {formatDateTime(seen.seenAt)}
                                            </TableCell>
                                            <TableCell>
                                                <Link
                                                    href={`/calistirmalar/${seen.runId}`}
                                                    className="font-mono text-xs text-primary hover:underline"
                                                >
                                                    {shortId(seen.runId)}
                                                </Link>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>İlişkili Çalıştırmalar</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {listing.runLinks.length === 0 ? (
                            <p className="text-sm text-muted-foreground">Çalıştırma bağlantısı yok.</p>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Run</TableHead>
                                        <TableHead>Durum</TableHead>
                                        <TableHead>Sonuç</TableHead>
                                        <TableHead className="text-right">Tarih</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {listing.runLinks.map((link) => (
                                        <TableRow key={link.runId}>
                                            <TableCell>
                                                <Link
                                                    href={`/calistirmalar/${link.runId}`}
                                                    className="font-mono text-xs text-primary hover:underline"
                                                >
                                                    {shortId(link.runId)}
                                                </Link>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant={RUN_STATUS_TONES[link.run.status]}>
                                                    {RUN_STATUS_LABELS[link.run.status]}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant={LISTING_OUTCOME_TONES[link.outcome]}>
                                                    {LISTING_OUTCOME_LABELS[link.outcome]}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right text-muted-foreground">
                                                {relativeTime(link.run.createdAt)}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>
            </div>

            <Separator />
            <p className="text-xs text-muted-foreground">
                İlk görülme {formatDateTime(listing.firstSeenAt)} · Son görülme {formatDateTime(listing.lastSeenAt)}
            </p>
        </div>
    );
}

function PriceChangePill({ percent }: { percent: number }) {
    const change = formatPriceChange(percent);
    if (change === null) return null;
    return (
        <span
            className={cn(
                'text-sm font-medium tabular-nums',
                change.direction === 'up' && 'text-destructive',
                change.direction === 'down' && 'text-success',
            )}
        >
            {change.text} toplam değişim
        </span>
    );
}
