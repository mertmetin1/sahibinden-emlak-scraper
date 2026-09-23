'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { listingQueryString, type ListingQuery } from '@/lib/listing-params';

export function ListingsSearchBar({ query }: { query: ListingQuery }) {
    const router = useRouter();
    const [value, setValue] = useState(query.filters.search ?? '');

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const filters = { ...query.filters };
        const trimmed = value.trim();
        if (trimmed === '') delete filters.search;
        else filters.search = trimmed;
        router.push(`/ilanlar?${listingQueryString({ ...query, page: 1, filters })}`);
    };

    return (
        <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-2">
            <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="Başlık, ilan no, mahalle, satıcı…"
                    className="pl-8"
                    aria-label="İlan ara"
                />
            </div>
            <Button type="submit" size="sm" variant="secondary">
                Ara
            </Button>
        </form>
    );
}
