import type { Metadata } from 'next';

import { ListingsFilterSheet } from '@/components/listings/filter-sheet';
import { ListingsTable } from '@/components/listings/listings-table';
import { Pagination } from '@/components/listings/pagination';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { activeFilterCount, listingQueryString, parseListingSearchParams } from '@/lib/listing-params';
import { serverApiGet } from '@/lib/server-api';
import type { ListingListResponse, ScanListResponse } from '@/lib/types';
import { Home } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'İlanlar' };

interface PageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ListingsPage({ searchParams }: PageProps) {
    const query = parseListingSearchParams(await searchParams);

    // Listings + the scan filter's options (operator-scale list) in parallel.
    const [listings, scans] = await Promise.all([
        serverApiGet<ListingListResponse>(`/api/listings?${listingQueryString(query)}`),
        serverApiGet<ScanListResponse>('/api/scans'),
    ]);

    const filterCount = activeFilterCount(query);
    // CSV export uses the same filters/sort, without pagination (streamed, capped server-side).
    const exportHref = `/api/listings/export.csv?${listingQueryString(query, { paginate: false })}`;

    return (
        <div className="space-y-4">
            <PageHeader
                title="İlanlar"
                description={`${listings.total.toLocaleString('tr-TR')} ilan`}
                actions={
                    <>
                        {/* key remounts the drawer on navigation so its form state re-syncs from the URL */}
                        <ListingsFilterSheet
                            key={listingQueryString(query)}
                            query={query}
                            filterCount={filterCount}
                            scans={scans.rows.map((s) => ({ id: s.id, name: s.name }))}
                        />
                        <Button asChild variant="outline" size="sm">
                            {/* Same-origin through the rewrite; content-disposition downloads. */}
                            <a href={exportHref}>CSV İndir</a>
                        </Button>
                    </>
                }
            />

            {listings.rows.length === 0 ? (
                <EmptyState
                    icon={Home}
                    title={filterCount > 0 ? 'Filtrelere uyan ilan bulunamadı' : 'Henüz ilan yok'}
                    description={
                        filterCount > 0
                            ? 'Filtreleri gevşetmeyi veya temizlemeyi deneyin.'
                            : 'İlanlar taramalar çalıştıkça burada birikir.'
                    }
                    action={
                        filterCount > 0 ? (
                            <Button asChild variant="outline" size="sm">
                                <Link href="/ilanlar">Filtreleri Temizle</Link>
                            </Button>
                        ) : (
                            <Button asChild size="sm">
                                <Link href="/taramalar">Taramalara Git</Link>
                            </Button>
                        )
                    }
                />
            ) : (
                <>
                    <ListingsTable rows={listings.rows} query={query} />
                    <Pagination
                        page={listings.page}
                        pageSize={listings.pageSize}
                        totalPages={listings.totalPages}
                        total={listings.total}
                        query={query}
                    />
                </>
            )}
        </div>
    );
}
