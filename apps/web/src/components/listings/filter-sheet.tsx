'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Field, SwitchField } from '@/components/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from '@/components/ui/sheet';
import { LISTING_STATUS_LABELS, SELLER_TYPE_LABELS } from '@/lib/labels';
import { listingQueryString, type ListingFilterKey, type ListingQuery } from '@/lib/listing-params';
import type { ListingStatus } from '@/lib/types';

/** Radix Select rejects empty-string item values — sentinel for "no filter". */
const ALL = '__all__';

interface FilterSheetProps {
    query: ListingQuery;
    filterCount: number;
    scans: Array<{ id: string; name: string }>;
}

export function ListingsFilterSheet({ query, filterCount, scans }: FilterSheetProps) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    // Text/number/date fields are plain strings; '' = no filter. priceChanged
    // is owned by the switch alone — excluded here so it can't leak back in.
    const [values, setValues] = useState<Record<string, string>>(() => {
        const initial = { ...query.filters } as Record<string, string>;
        delete initial.priceChanged;
        return initial;
    });
    const [priceChanged, setPriceChanged] = useState(query.filters.priceChanged === 'true');

    const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));

    const apply = () => {
        const filters: Partial<Record<ListingFilterKey, string>> = {};
        for (const [key, value] of Object.entries(values)) {
            const trimmed = value.trim();
            if (trimmed !== '' && trimmed !== ALL) filters[key as ListingFilterKey] = trimmed;
        }
        if (priceChanged) filters.priceChanged = 'true';
        // Applying filters always returns to page 1.
        router.push(`/ilanlar?${listingQueryString({ ...query, page: 1, filters })}`);
        setOpen(false);
    };

    const clear = () => {
        router.push('/ilanlar');
        setOpen(false);
    };

    return (
        <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
                <Button variant="outline" size="sm">
                    <SlidersHorizontal />
                    Filtrele
                    {filterCount > 0 && <Badge variant="default">{filterCount}</Badge>}
                </Button>
            </SheetTrigger>
            <SheetContent side="right" className="flex flex-col overflow-y-auto p-6">
                <SheetHeader>
                    <SheetTitle>İlan Filtreleri</SheetTitle>
                    <SheetDescription>
                        Filtreler sunucuda uygulanır; sonuç URL&apos;ye yansır ve paylaşılabilir.
                    </SheetDescription>
                </SheetHeader>

                <div className="mt-4 flex flex-1 flex-col gap-4">
                    <Field label="Arama" htmlFor="f-search" hint="Başlık, açıklama, ilan no veya satıcı">
                        <Input
                            id="f-search"
                            value={values.search ?? ''}
                            onChange={(e) => set('search', e.target.value)}
                            placeholder="ör. Kadıköy 2+1"
                        />
                    </Field>

                    <div className="grid grid-cols-2 gap-3">
                        <Field label="İl" htmlFor="f-province">
                            <Input
                                id="f-province"
                                value={values.province ?? ''}
                                onChange={(e) => set('province', e.target.value)}
                                placeholder="İstanbul"
                            />
                        </Field>
                        <Field label="İlçe" htmlFor="f-district">
                            <Input
                                id="f-district"
                                value={values.district ?? ''}
                                onChange={(e) => set('district', e.target.value)}
                                placeholder="Kadıköy"
                            />
                        </Field>
                    </div>

                    <Field label="Mahalle" htmlFor="f-neighborhood">
                        <Input
                            id="f-neighborhood"
                            value={values.neighborhood ?? ''}
                            onChange={(e) => set('neighborhood', e.target.value)}
                            placeholder="Moda"
                        />
                    </Field>

                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Satıcı Tipi">
                            <Select
                                value={values.sellerType ?? ALL}
                                onValueChange={(v) => set('sellerType', v)}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ALL}>Tümü</SelectItem>
                                    {Object.entries(SELLER_TYPE_LABELS).map(([value, label]) => (
                                        <SelectItem key={value} value={value}>
                                            {label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field label="İlan Tipi">
                            <Select
                                value={values.listingType ?? ALL}
                                onValueChange={(v) => set('listingType', v)}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ALL}>Tümü</SelectItem>
                                    <SelectItem value="SALE">Satılık</SelectItem>
                                    <SelectItem value="RENT">Kiralık</SelectItem>
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Mülk Tipi" htmlFor="f-category">
                            <Input
                                id="f-category"
                                value={values.propertyCategory ?? ''}
                                onChange={(e) => set('propertyCategory', e.target.value)}
                                placeholder="Konut"
                            />
                        </Field>
                        <Field label="Oda" htmlFor="f-rooms">
                            <Input
                                id="f-rooms"
                                value={values.rooms ?? ''}
                                onChange={(e) => set('rooms', e.target.value)}
                                placeholder="2+1"
                            />
                        </Field>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Fiyat (min)" htmlFor="f-priceMin">
                            <Input
                                id="f-priceMin"
                                type="number"
                                min={0}
                                value={values.priceMin ?? ''}
                                onChange={(e) => set('priceMin', e.target.value)}
                            />
                        </Field>
                        <Field label="Fiyat (maks)" htmlFor="f-priceMax">
                            <Input
                                id="f-priceMax"
                                type="number"
                                min={0}
                                value={values.priceMax ?? ''}
                                onChange={(e) => set('priceMax', e.target.value)}
                            />
                        </Field>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <Field label="m² (min)" htmlFor="f-m2Min">
                            <Input
                                id="f-m2Min"
                                type="number"
                                min={0}
                                value={values.m2Min ?? ''}
                                onChange={(e) => set('m2Min', e.target.value)}
                            />
                        </Field>
                        <Field label="m² (maks)" htmlFor="f-m2Max">
                            <Input
                                id="f-m2Max"
                                type="number"
                                min={0}
                                value={values.m2Max ?? ''}
                                onChange={(e) => set('m2Max', e.target.value)}
                            />
                        </Field>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <Field label="İlk Görülme (sonrası)" htmlFor="f-firstSeenFrom">
                            <Input
                                id="f-firstSeenFrom"
                                type="date"
                                value={values.firstSeenFrom ?? ''}
                                onChange={(e) => set('firstSeenFrom', e.target.value)}
                            />
                        </Field>
                        <Field label="Son Görülme (öncesi)" htmlFor="f-lastSeenBefore">
                            <Input
                                id="f-lastSeenBefore"
                                type="date"
                                value={values.lastSeenBefore ?? ''}
                                onChange={(e) => set('lastSeenBefore', e.target.value)}
                            />
                        </Field>
                    </div>

                    <Field label="Tarama Kaynağı">
                        <Select value={values.scanId ?? ALL} onValueChange={(v) => set('scanId', v)}>
                            <SelectTrigger>
                                <SelectValue placeholder="Tümü" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL}>Tümü</SelectItem>
                                {scans.map((scan) => (
                                    <SelectItem key={scan.id} value={scan.id}>
                                        {scan.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>

                    <Field label="Durum">
                        <Select value={values.status ?? ALL} onValueChange={(v) => set('status', v)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL}>Tümü</SelectItem>
                                {(Object.entries(LISTING_STATUS_LABELS) as Array<[ListingStatus, string]>).map(
                                    ([value, label]) => (
                                        <SelectItem key={value} value={value}>
                                            {label}
                                        </SelectItem>
                                    ),
                                )}
                            </SelectContent>
                        </Select>
                    </Field>

                    <SwitchField
                        id="f-priceChanged"
                        label="Sadece fiyatı değişenler"
                        description="Fiyat geçmişi olan ilanlar"
                        checked={priceChanged}
                        onCheckedChange={setPriceChanged}
                    />
                </div>

                <SheetFooter className="mt-6">
                    <Button variant="ghost" onClick={clear}>
                        Temizle
                    </Button>
                    <Button onClick={apply}>Uygula</Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
