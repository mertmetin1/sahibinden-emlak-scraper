'use client';

import { X } from 'lucide-react';
import Link from 'next/link';

import { LISTING_STATUS_LABELS, LISTING_TYPE_LABELS, SELLER_TYPE_LABELS } from '@/lib/labels';
import {
    LISTING_FILTER_CHIP_LABELS,
    listingQueryString,
    type ListingFilterKey,
    type ListingQuery,
} from '@/lib/listing-params';
import type { ListingStatus, SellerType } from '@/lib/types';

function chipValue(key: ListingFilterKey, value: string, scans: Array<{ id: string; name: string }>): string {
    if (key === 'priceChanged') return 'Sadece değişenler';
    if (key === 'sellerType') return SELLER_TYPE_LABELS[value as SellerType] ?? value;
    if (key === 'listingType') return LISTING_TYPE_LABELS[value] ?? value;
    if (key === 'status') return LISTING_STATUS_LABELS[value as ListingStatus] ?? value;
    if (key === 'scanId') return scans.find((s) => s.id === value)?.name ?? value;
    return value;
}

export function ListingsActiveFilters({
    query,
    scans,
}: {
    query: ListingQuery;
    scans: Array<{ id: string; name: string }>;
}) {
    const entries = (Object.entries(query.filters) as Array<[ListingFilterKey, string | undefined]>).filter(
        (entry): entry is [ListingFilterKey, string] => entry[1] !== undefined && entry[1] !== '',
    );
    if (entries.length === 0) return null;

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {entries.map(([key, value]) => {
                const filters = { ...query.filters };
                delete filters[key];
                const href = `/ilanlar?${listingQueryString({ ...query, page: 1, filters })}`;
                return (
                    <Link
                        key={key}
                        href={href}
                        className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-xs hover:bg-accent"
                    >
                        <span className="text-muted-foreground">{LISTING_FILTER_CHIP_LABELS[key]}</span>
                        <span className="font-medium">{chipValue(key, value, scans)}</span>
                        <X className="size-3 text-muted-foreground" />
                    </Link>
                );
            })}
            <Link href="/ilanlar" className="px-2 text-xs text-muted-foreground hover:text-foreground hover:underline">
                Tümünü temizle
            </Link>
        </div>
    );
}
