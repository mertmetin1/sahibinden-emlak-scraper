import type { Metadata } from 'next';

import { ListingsActiveFilters } from '@/components/listings/listings-active-filters';
import { ListingsFilterSheet } from '@/components/listings/filter-sheet';
import { ListingsSearchBar } from '@/components/listings/listings-search-bar';
import { ListingsTable } from '@/components/listings/listings-table';
import { Pagination } from '@/components/listings/pagination';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { activeFilterCount, listingQueryString, parseListingSearchParams } from '@/lib/listing-params';
import { serverApiGet } from '@/lib/server-api';
import {
    EMPTY_LISTING_FACETS,
    type ListingFacetsDto,
    type ListingListResponse,
    type ScanListResponse,
} from '@/lib/types';
import { Home } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'İlanlar' };

interface PageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ListingsPage({ searchParams }: PageProps) {
    const query = parseListingSearchParams(await searchParams);
    const scanOptions = (scans: ScanListResponse) => scans.rows.map((s) => ({ id: s.id, name: s.name }));

    const facetQuery = listingQueryString(query, { paginate: false });
    const [listings, scans, facets] = await Promise.all([
        serverApiGet<ListingListResponse>(`/api/listings?${listingQueryString(query)}`),
        serverApiGet<ScanListResponse>('/api/scans'),
        serverApiGet<ListingFacetsDto>(`/api/listings/facets?${facetQuery}`).catch(() => EMPTY_LISTING_FACETS),
    ]);

    const filterCount = activeFilterCount(query);
    const exportHref = `/api/listings/export.csv?${listingQueryString(query, { paginate: false })}`;
    const scanRows = scanOptions(scans);

    return (
        <div className="space-y-4">
            <PageHeader
                title="İlanlar"
                description={`${listings.total.toLocaleString('tr-TR')} ilan`}
                actions={
                    <>
                        <ListingsFilterSheet
                            key={listingQueryString(query)}
                            query={query}
                            filterCount={filterCount}
                            scans={scanRows}
                            facets={facets}
                        />
                        <Button asChild variant="outline" size="sm">
                            <a href={exportHref}>CSV İndir</a>
                        </Button>
                    </>
                }
            />

            <div className="flex flex-col gap-2">
                <ListingsSearchBar key={query.filters.search ?? ''} query={query} />
                <ListingsActiveFilters query={query} scans={scanRows} />
            </div>

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
