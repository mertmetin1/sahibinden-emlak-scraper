import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { listingQueryString, type ListingQuery } from '@/lib/listing-params';
import { cn } from '@/lib/utils';

const PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * Server-rendered pagination: every control is a plain link carrying the
 * full query state, so pages stay URL-addressable and shareable.
 */
export function Pagination({
    page,
    pageSize,
    totalPages,
    total,
    query,
}: {
    page: number;
    pageSize: number;
    totalPages: number;
    total: number;
    query: ListingQuery;
}) {
    const hrefFor = (overrides: Partial<ListingQuery>) =>
        `/ilanlar?${listingQueryString({ ...query, ...overrides })}`;

    return (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span className="tabular-nums">
                Sayfa {page} / {Math.max(totalPages, 1)} · toplam {total.toLocaleString('tr-TR')} ilan
            </span>
            <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                    <span className="mr-1 text-xs">Sayfa boyutu:</span>
                    {PAGE_SIZES.map((size) => (
                        <Link
                            key={size}
                            href={hrefFor({ page: 1, pageSize: size })}
                            className={cn(
                                buttonVariants({ variant: size === pageSize ? 'default' : 'outline', size: 'sm' }),
                                'h-7 px-2 text-xs',
                            )}
                        >
                            {size}
                        </Link>
                    ))}
                </div>
                <div className="flex items-center gap-1">
                    {page > 1 ? (
                        <Link
                            href={hrefFor({ page: page - 1 })}
                            className={cn(buttonVariants({ variant: 'outline', size: 'icon-sm' }))}
                            aria-label="Önceki sayfa"
                        >
                            <ChevronLeft />
                        </Link>
                    ) : (
                        <span className={cn(buttonVariants({ variant: 'outline', size: 'icon-sm' }), 'pointer-events-none opacity-40')}>
                            <ChevronLeft />
                        </span>
                    )}
                    {page < totalPages ? (
                        <Link
                            href={hrefFor({ page: page + 1 })}
                            className={cn(buttonVariants({ variant: 'outline', size: 'icon-sm' }))}
                            aria-label="Sonraki sayfa"
                        >
                            <ChevronRight />
                        </Link>
                    ) : (
                        <span className={cn(buttonVariants({ variant: 'outline', size: 'icon-sm' }), 'pointer-events-none opacity-40')}>
                            <ChevronRight />
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
