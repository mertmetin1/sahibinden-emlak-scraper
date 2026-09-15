'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Read-only configuration snapshot viewer (collapsible pretty JSON). */
export function SnapshotViewer({ snapshot }: { snapshot: unknown }) {
    const [open, setOpen] = useState(false);

    return (
        <Card>
            <CardHeader className="p-0">
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className="flex w-full items-center justify-between p-4 text-left"
                    aria-expanded={open}
                >
                    <CardTitle>Yapılandırma Anlık Görüntüsü</CardTitle>
                    <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
                </button>
            </CardHeader>
            {open && (
                <CardContent>
                    <pre className="max-h-[420px] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
                        {JSON.stringify(snapshot, null, 2)}
                    </pre>
                    <p className="mt-2 text-xs text-muted-foreground">
                        Run&apos;lar bu değişmez anlık görüntüden çalışır; tarama tanımı sonradan değişse bile etkilenmez.
                    </p>
                </CardContent>
            )}
        </Card>
    );
}
