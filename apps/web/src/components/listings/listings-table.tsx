import { ArrowDown, ArrowUp, ArrowUpDown, ImageOff } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatNumber, formatPrice, formatPriceChange, relativeTime } from '@/lib/format';
import {
    LISTING_STATUS_TONES,
    LISTING_STATUS_LABELS,
    SELLER_TYPE_LABELS,
    SELLER_TYPE_TONES,
} from '@/lib/labels';
import { listingQueryString, type ListingQuery, type ListingSortField } from '@/lib/listing-params';
import type { ListingListRow, SellerType } from '@/lib/types';
import { cn } from '@/lib/utils';

function SortableHead({
    field,
    label,
    query,
    className,
}: {
    field: ListingSortField;
    label: string;
    query: ListingQuery;
    className?: string;
}) {
    const active = query.sort === field;
    const nextOrder = active && query.order === 'desc' ? 'asc' : 'desc';
    const href = `/ilanlar?${listingQueryString({ ...query, sort: field, order: nextOrder })}`;
    const Icon = active ? (query.order === 'desc' ? ArrowDown : ArrowUp) : ArrowUpDown;
    return (
        <TableHead className={className}>
            <Link
                href={href}
                className={cn(
                    'inline-flex items-center gap-1 hover:text-foreground',
                    active && 'text-foreground',
                )}
            >
                {label}
                <Icon className="size-3" />
            </Link>
        </TableHead>
    );
}

function locationText(row: ListingListRow): string {
    const parts = [row.district, row.neighborhood].filter((p): p is string => p !== null && p !== '');
    if (parts.length > 0) return parts.join(' / ');
    if (row.province !== null && row.province !== '') return row.province;
    return row.locationRaw !== '' ? row.locationRaw : '—';
}

export function ListingsTable({ rows, query }: { rows: ListingListRow[]; query: ListingQuery }) {
    return (
        <div className="rounded-lg border bg-card">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-[56px]"></TableHead>
                        <TableHead className="w-[110px]">İlan No</TableHead>
                        <SortableHead field="title" label="Başlık" query={query} />
                        <SortableHead field="price" label="Fiyat" query={query} className="text-right" />
                        <SortableHead field="area" label="m²" query={query} className="text-right" />
                        <TableHead className="text-right">TL/m²</TableHead>
                        <TableHead>Konum</TableHead>
                        <TableHead>Satıcı</TableHead>
                        <TableHead>Durum</TableHead>
                        <SortableHead field="firstSeenAt" label="İlk Görülme" query={query} />
                        <SortableHead field="lastSeenAt" label="Son Görülme" query={query} />
                        <TableHead className="text-right">Fiyat Değ.</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => {
                        const change = formatPriceChange(row.latestPriceChangePercent);
                        const sellerType = (row.seller?.type ?? row.sellerType ?? 'UNKNOWN') as SellerType;
                        return (
                            <TableRow key={row.id}>
                                <TableCell className="w-[56px] p-1">
                                    {row.thumbnailUrl ? (
                                        <img
                                            src={row.thumbnailUrl}
                                            alt=""
                                            loading="lazy"
                                            className="size-12 rounded-md border bg-muted object-cover"
                                        />
                                    ) : (
                                        <div className="flex size-12 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                                            <ImageOff className="size-4" />
                                        </div>
                                    )}
                                </TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground">
                                    {row.sourceListingId}
                                </TableCell>
                                <TableCell className="max-w-[320px]">
                                    <Link
                                        href={`/ilanlar/${row.id}`}
                                        className="line-clamp-2 font-medium text-primary hover:underline"
                                        title={row.title}
                                    >
                                        {row.title}
                                    </Link>
                                </TableCell>
                                <TableCell className="text-right font-medium tabular-nums">
                                    {formatPrice(row.price, row.currency)}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                    {formatNumber(row.grossAreaM2)}
                                </TableCell>
                                <TableCell className="text-right tabular-nums text-muted-foreground">
                                    {row.pricePerSquareMeter !== null
                                        ? `${formatNumber(row.pricePerSquareMeter)} TL`
                                        : '—'}
                                </TableCell>
                                <TableCell className="max-w-[180px]">
                                    <span className="line-clamp-1" title={locationText(row)}>
                                        {locationText(row)}
                                    </span>
                                </TableCell>
                                <TableCell>
                                    <Badge variant={SELLER_TYPE_TONES[sellerType] ?? 'outline'}>
                                        {SELLER_TYPE_LABELS[sellerType] ?? sellerType}
                                    </Badge>
                                </TableCell>
                                <TableCell>
                                    <Badge variant={LISTING_STATUS_TONES[row.status]}>
                                        {LISTING_STATUS_LABELS[row.status]}
                                    </Badge>
                                </TableCell>
                                <TableCell className="whitespace-nowrap text-muted-foreground">
                                    {formatDate(row.firstSeenAt)}
                                </TableCell>
                                <TableCell className="whitespace-nowrap text-muted-foreground">
                                    {relativeTime(row.lastSeenAt)}
                                </TableCell>
                                <TableCell
                                    className={cn(
                                        'text-right tabular-nums',
                                        change?.direction === 'up' && 'text-destructive',
                                        change?.direction === 'down' && 'text-success',
                                    )}
                                >
                                    {change?.text ?? '—'}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}
