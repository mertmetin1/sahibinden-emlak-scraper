'use client';

import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TableRow } from '@/components/ui/table';
import { ApiError, apiPost } from '@/lib/api';
import { API_ERROR_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

const MAX_SELECTION = 200;

function toastApiError(err: unknown, fallback: string) {
    if (err instanceof ApiError) {
        toast.error(API_ERROR_LABELS[err.code] ?? fallback, { description: err.message });
    } else {
        toast.error(fallback);
    }
}

interface SelectionContextValue {
    pageIds: string[];
    selected: Set<string>;
    selectedCount: number;
    allOnPage: boolean;
    someOnPage: boolean;
    toggleOne: (id: string, checked: boolean) => void;
    togglePage: (checked: boolean) => void;
    clearSelection: () => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

function useSelection(): SelectionContextValue {
    const ctx = useContext(SelectionContext);
    if (ctx === null) {
        throw new Error('listings selection context missing');
    }
    return ctx;
}

export function ListingsSelectionProvider({
    pageIds,
    children,
}: {
    pageIds: string[];
    children: ReactNode;
}) {
    const [selected, setSelected] = useState<Set<string>>(() => new Set());

    const selectedOnPage = pageIds.filter((id) => selected.has(id));
    const allOnPage = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
    const someOnPage = selectedOnPage.length > 0 && !allOnPage;

    const toggleOne = useCallback((id: string, checked: boolean) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (checked) {
                if (!next.has(id) && next.size >= MAX_SELECTION) {
                    toast.error(`En fazla ${MAX_SELECTION} ilan seçilebilir`);
                    return prev;
                }
                next.add(id);
            } else {
                next.delete(id);
            }
            return next;
        });
    }, []);

    const togglePage = useCallback(
        (checked: boolean) => {
            setSelected((prev) => {
                const next = new Set(prev);
                if (!checked) {
                    for (const id of pageIds) next.delete(id);
                    return next;
                }
                for (const id of pageIds) {
                    if (next.has(id)) continue;
                    if (next.size >= MAX_SELECTION) {
                        toast.error(`En fazla ${MAX_SELECTION} ilan seçilebilir`);
                        break;
                    }
                    next.add(id);
                }
                return next;
            });
        },
        [pageIds],
    );

    const clearSelection = useCallback(() => setSelected(new Set()), []);

    const value = useMemo<SelectionContextValue>(
        () => ({
            pageIds,
            selected,
            selectedCount: selected.size,
            allOnPage,
            someOnPage,
            toggleOne,
            togglePage,
            clearSelection,
        }),
        [pageIds, selected, allOnPage, someOnPage, toggleOne, togglePage, clearSelection],
    );

    return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function ListingsBulkToolbar() {
    const router = useRouter();
    const { selected, selectedCount, togglePage, clearSelection } = useSelection();
    const [confirmOpen, setConfirmOpen] = useState(false);

    const removeSelected = async () => {
        const ids = [...selected];
        if (ids.length === 0) return;
        try {
            const result = await apiPost<{ deleted: number }>('/api/listings/bulk-delete', { ids });
            toast.success(`${result.deleted.toLocaleString('tr-TR')} ilan silindi`);
            clearSelection();
            router.refresh();
        } catch (err) {
            toastApiError(err, 'İlanlar silinemedi');
            throw err;
        }
    };

    return (
        <>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                    {selectedCount > 0
                        ? `${selectedCount.toLocaleString('tr-TR')} ilan seçildi`
                        : 'Toplu işlem için satır seçin'}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => togglePage(true)}>
                        Sayfadakileri seç
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={selectedCount === 0}
                        onClick={clearSelection}
                    >
                        Seçimi temizle
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={selectedCount === 0}
                        onClick={() => setConfirmOpen(true)}
                    >
                        <Trash2 />
                        Sil
                    </Button>
                </div>
            </div>
            <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title={`${selectedCount.toLocaleString('tr-TR')} ilan silinsin mi?`}
                description="Bu işlem geri alınamaz. İlan kayıtları, görseller, özellikler ve fiyat geçmişi kalıcı olarak silinir. Çalışan taramaya dokunulmaz; tarama aynı ilanları yeniden görürse tekrar ekler."
                confirmLabel="Sil"
                destructive
                onConfirm={removeSelected}
            />
        </>
    );
}

export function SelectAllCheckbox() {
    const { allOnPage, someOnPage, togglePage } = useSelection();
    return (
        <Checkbox
            checked={allOnPage ? true : someOnPage ? 'indeterminate' : false}
            onCheckedChange={(value) => togglePage(value === true)}
            aria-label="Sayfadaki ilanları seç"
        />
    );
}

export function RowCheckbox({ id, label }: { id: string; label: string }) {
    const { selected, toggleOne } = useSelection();
    return (
        <Checkbox
            checked={selected.has(id)}
            onCheckedChange={(value) => toggleOne(id, value === true)}
            aria-label={`${label} seç`}
        />
    );
}

export function SelectableRow({
    id,
    className,
    children,
}: {
    id: string;
    className?: string;
    children: ReactNode;
}) {
    const { selected } = useSelection();
    return (
        <TableRow className={cn(className)} data-state={selected.has(id) ? 'selected' : undefined}>
            {children}
        </TableRow>
    );
}
