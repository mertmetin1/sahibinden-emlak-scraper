'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';

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
import {
    HEATING_OPTIONS,
    LISTING_STATUS_LABELS,
    LISTING_TYPE_LABELS,
    PROPERTY_CATEGORY_OPTIONS,
    PROPERTY_SUBTYPE_OPTIONS,
    ROOM_OPTIONS,
    SELLER_TYPE_LABELS,
    YES_NO_OPTIONS,
} from '@/lib/labels';
import { listingQueryString, type ListingFilterKey, type ListingQuery } from '@/lib/listing-params';
import type { ListingFacetsDto } from '@/lib/types';

const ALL = '__all__';

interface FilterSheetProps {
    query: ListingQuery;
    filterCount: number;
    scans: Array<{ id: string; name: string }>;
    facets: ListingFacetsDto;
}

function mergeOptions(presets: readonly string[], facets: string[] | undefined, current?: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of [...(facets ?? []), ...presets, current ?? '']) {
        const value = raw.trim();
        if (value === '' || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

function FilterSection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="space-y-3 border-b pb-4 last:border-b-0">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
            {children}
        </section>
    );
}

function FilterSelect({
    label,
    value,
    onChange,
    options,
    labels,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: string[];
    labels?: Partial<Record<string, string>>;
}) {
    return (
        <Field label={label}>
            <Select value={value === '' ? ALL : value} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
                <SelectTrigger>
                    <SelectValue placeholder="Tümü" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={ALL}>Tümü</SelectItem>
                    {options.map((option) => (
                        <SelectItem key={option} value={option}>
                            {labels?.[option] ?? LISTING_TYPE_LABELS[option] ?? option}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
}

export function ListingsFilterSheet({ query, filterCount, scans, facets }: FilterSheetProps) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [values, setValues] = useState<Record<string, string>>(() => {
        const initial = { ...query.filters } as Record<string, string>;
        delete initial.priceChanged;
        delete initial.search;
        return initial;
    });
    const [priceChanged, setPriceChanged] = useState(query.filters.priceChanged === 'true');

    const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));

    const subtypeOptions = useMemo(() => {
        const category = values.propertyCategory ?? '';
        const presets = category !== '' && PROPERTY_SUBTYPE_OPTIONS[category] !== undefined
            ? PROPERTY_SUBTYPE_OPTIONS[category]
            : Object.values(PROPERTY_SUBTYPE_OPTIONS).flat();
        return mergeOptions(presets, facets.propertySubtype, values.propertySubtype);
    }, [values.propertyCategory, values.propertySubtype, facets.propertySubtype]);

    const apply = () => {
        const filters: Partial<Record<ListingFilterKey, string>> = {};
        if (query.filters.search) filters.search = query.filters.search;
        for (const [key, value] of Object.entries(values)) {
            const trimmed = value.trim();
            if (trimmed !== '' && trimmed !== ALL) filters[key as ListingFilterKey] = trimmed;
        }
        if (priceChanged) filters.priceChanged = 'true';
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
            <SheetContent side="right" className="flex w-full flex-col overflow-y-auto p-6 sm:max-w-lg">
                <SheetHeader>
                    <SheetTitle>İlan Filtreleri</SheetTitle>
                    <SheetDescription>
                        Tip, tür, oda ve konum filtreleri sunucuda uygulanır; URL paylaşılabilir.
                    </SheetDescription>
                </SheetHeader>

                <div className="mt-4 flex flex-1 flex-col gap-4">
                    <FilterSection title="İlan ve mülk tipi">
                        <div className="grid grid-cols-2 gap-3">
                            <FilterSelect
                                label="İlan tipi"
                                value={values.listingType ?? ''}
                                onChange={(v) => set('listingType', v)}
                                options={mergeOptions(['SALE', 'RENT', 'UNKNOWN'], facets.listingType, values.listingType)}
                            />
                            <Field label="Satıcı tipi">
                                <Select
                                    value={values.sellerType ?? ALL}
                                    onValueChange={(v) => set('sellerType', v === ALL ? '' : v)}
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
                            <FilterSelect
                                label="Mülk tipi"
                                value={values.propertyCategory ?? ''}
                                onChange={(v) => {
                                    setValues((prev) => ({
                                        ...prev,
                                        propertyCategory: v,
                                        propertySubtype: '',
                                    }));
                                }}
                                options={mergeOptions(PROPERTY_CATEGORY_OPTIONS, facets.propertyCategory, values.propertyCategory)}
                            />
                            <FilterSelect
                                label="Tür / emlak tipi"
                                value={values.propertySubtype ?? ''}
                                onChange={(v) => set('propertySubtype', v)}
                                options={subtypeOptions}
                            />
                            <FilterSelect
                                label="Oda sayısı"
                                value={values.rooms ?? ''}
                                onChange={(v) => set('rooms', v)}
                                options={mergeOptions(ROOM_OPTIONS, facets.rooms, values.rooms)}
                            />
                            <FilterSelect
                                label="Durum"
                                value={values.status ?? ''}
                                onChange={(v) => set('status', v)}
                                options={Object.keys(LISTING_STATUS_LABELS)}
                                labels={LISTING_STATUS_LABELS}
                            />
                        </div>
                    </FilterSection>

                    <FilterSection title="Konum">
                        <div className="grid grid-cols-2 gap-3">
                            <FilterSelect
                                label="İl"
                                value={values.province ?? ''}
                                onChange={(v) => set('province', v)}
                                options={mergeOptions([], facets.province, values.province)}
                            />
                            <FilterSelect
                                label="İlçe"
                                value={values.district ?? ''}
                                onChange={(v) => set('district', v)}
                                options={mergeOptions([], facets.district, values.district)}
                            />
                        </div>
                        <FilterSelect
                            label="Mahalle"
                            value={values.neighborhood ?? ''}
                            onChange={(v) => set('neighborhood', v)}
                            options={mergeOptions([], facets.neighborhood, values.neighborhood)}
                        />
                        <Field label="Site adı" htmlFor="f-siteName">
                            <Input
                                id="f-siteName"
                                value={values.siteName ?? ''}
                                onChange={(e) => set('siteName', e.target.value)}
                                placeholder="ör. Tema City"
                            />
                        </Field>
                    </FilterSection>

                    <FilterSection title="Özellikler">
                        <div className="grid grid-cols-2 gap-3">
                            <FilterSelect
                                label="Isıtma"
                                value={values.heating ?? ''}
                                onChange={(v) => set('heating', v)}
                                options={mergeOptions(HEATING_OPTIONS, facets.heating, values.heating)}
                            />
                            <FilterSelect
                                label="Bina yaşı"
                                value={values.buildingAge ?? ''}
                                onChange={(v) => set('buildingAge', v)}
                                options={mergeOptions([], facets.buildingAge, values.buildingAge)}
                            />
                            <FilterSelect
                                label="Kat"
                                value={values.floor ?? ''}
                                onChange={(v) => set('floor', v)}
                                options={mergeOptions([], facets.floor, values.floor)}
                            />
                            <FilterSelect
                                label="Banyo"
                                value={values.bathroomCount ?? ''}
                                onChange={(v) => set('bathroomCount', v)}
                                options={mergeOptions(['1', '2', '3', '4', '5'], facets.bathroomCount, values.bathroomCount)}
                            />
                            <FilterSelect
                                label="Balkon"
                                value={values.balcony ?? ''}
                                onChange={(v) => set('balcony', v)}
                                options={mergeOptions(YES_NO_OPTIONS, facets.balcony, values.balcony)}
                            />
                            <FilterSelect
                                label="Eşya"
                                value={values.furnished ?? ''}
                                onChange={(v) => set('furnished', v)}
                                options={mergeOptions(YES_NO_OPTIONS, facets.furnished, values.furnished)}
                            />
                            <FilterSelect
                                label="Kullanım durumu"
                                value={values.usageStatus ?? ''}
                                onChange={(v) => set('usageStatus', v)}
                                options={mergeOptions(['Boş', 'Kiracılı', 'Mülk Sahibi'], facets.usageStatus, values.usageStatus)}
                            />
                            <FilterSelect
                                label="Site içinde"
                                value={values.insideSite ?? ''}
                                onChange={(v) => set('insideSite', v)}
                                options={mergeOptions(YES_NO_OPTIONS, facets.insideSite, values.insideSite)}
                            />
                            <FilterSelect
                                label="Krediye uygun"
                                value={values.creditEligible ?? ''}
                                onChange={(v) => set('creditEligible', v)}
                                options={mergeOptions(YES_NO_OPTIONS, facets.creditEligible, values.creditEligible)}
                            />
                            <FilterSelect
                                label="Takas"
                                value={values.exchangeEligible ?? ''}
                                onChange={(v) => set('exchangeEligible', v)}
                                options={mergeOptions(YES_NO_OPTIONS, facets.exchangeEligible, values.exchangeEligible)}
                            />
                        </div>
                    </FilterSection>

                    <FilterSection title="Fiyat ve alan">
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
                    </FilterSection>

                    <FilterSection title="Tarih ve kaynak">
                        <div className="grid grid-cols-2 gap-3">
                            <Field label="İlk görülme (sonrası)" htmlFor="f-firstSeenFrom">
                                <Input
                                    id="f-firstSeenFrom"
                                    type="date"
                                    value={values.firstSeenFrom ?? ''}
                                    onChange={(e) => set('firstSeenFrom', e.target.value)}
                                />
                            </Field>
                            <Field label="Son görülme (öncesi)" htmlFor="f-lastSeenBefore">
                                <Input
                                    id="f-lastSeenBefore"
                                    type="date"
                                    value={values.lastSeenBefore ?? ''}
                                    onChange={(e) => set('lastSeenBefore', e.target.value)}
                                />
                            </Field>
                        </div>
                        <Field label="Tarama kaynağı">
                            <Select value={values.scanId ?? ALL} onValueChange={(v) => set('scanId', v === ALL ? '' : v)}>
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
                        <SwitchField
                            id="f-priceChanged"
                            label="Sadece fiyatı değişenler"
                            description="Fiyat geçmişi olan ilanlar"
                            checked={priceChanged}
                            onCheckedChange={setPriceChanged}
                        />
                    </FilterSection>
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
