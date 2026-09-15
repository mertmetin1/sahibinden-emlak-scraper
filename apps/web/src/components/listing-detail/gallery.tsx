'use client';

import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { ListingImageDto } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Photo gallery: primary image first, then by position. Click opens a dialog
 * viewer with prev/next. Plain <img> — listing photos are external CDN URLs.
 */
export function Gallery({ images }: { images: ListingImageDto[] }) {
    const ordered = [...images].sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
        return a.position - b.position;
    });
    const [openIndex, setOpenIndex] = useState<number | null>(null);

    if (ordered.length === 0) {
        return (
            <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border bg-card text-muted-foreground">
                <ImageOff className="size-6" />
                <span className="text-sm">Fotoğraf yok</span>
            </div>
        );
    }

    const current = openIndex !== null ? ordered[openIndex] : undefined;

    return (
        <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {ordered.map((image, index) => (
                    <button
                        key={image.id}
                        type="button"
                        onClick={() => setOpenIndex(index)}
                        className={cn(
                            'group relative aspect-[4/3] overflow-hidden rounded-md border bg-muted',
                            index === 0 && 'col-span-2 row-span-2 aspect-auto sm:aspect-[4/3]',
                        )}
                    >
                        {/* Plain img: external CDN URLs, no next/image domain config needed. */}
                        <img
                            src={image.url}
                            alt=""
                            loading="lazy"
                            className="size-full object-cover transition-transform group-hover:scale-105"
                        />
                        {image.isPrimary && (
                            <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                                Kapak
                            </span>
                        )}
                    </button>
                ))}
            </div>

            <Dialog open={openIndex !== null} onOpenChange={(open) => !open && setOpenIndex(null)}>
                <DialogContent className="max-w-4xl p-2">
                    {current !== undefined && (
                        <div className="relative">
                            {/* Plain img: external CDN URLs, no next/image domain config needed. */}
                            <img
                                src={current.url}
                                alt=""
                                className="max-h-[80vh] w-full rounded-md object-contain"
                            />
                            <div className="absolute inset-x-0 bottom-2 flex items-center justify-center gap-2">
                                <Button
                                    variant="secondary"
                                    size="icon-sm"
                                    disabled={openIndex === 0}
                                    onClick={() => setOpenIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
                                    aria-label="Önceki fotoğraf"
                                >
                                    <ChevronLeft />
                                </Button>
                                <span className="rounded bg-black/60 px-2 py-0.5 text-xs text-white tabular-nums">
                                    {(openIndex ?? 0) + 1} / {ordered.length}
                                </span>
                                <Button
                                    variant="secondary"
                                    size="icon-sm"
                                    disabled={openIndex === ordered.length - 1}
                                    onClick={() =>
                                        setOpenIndex((i) => (i !== null && i < ordered.length - 1 ? i + 1 : i))
                                    }
                                    aria-label="Sonraki fotoğraf"
                                >
                                    <ChevronRight />
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
