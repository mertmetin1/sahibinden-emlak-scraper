'use client';

import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Error state with retry. Used by route-level error.tsx boundaries (reset
 * re-renders the segment) and by client components (onRetry callback).
 */
export function ErrorState({
    title = 'Bir şeyler ters gitti',
    message,
    onRetry,
    retryLabel = 'Tekrar Dene',
}: {
    title?: string;
    message?: string;
    onRetry?: () => void;
    retryLabel?: string;
}) {
    return (
        <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="size-5 text-destructive" />
            </div>
            <h2 className="text-sm font-semibold">{title}</h2>
            {message !== undefined && message !== '' && (
                <p className="max-w-lg break-words text-sm text-muted-foreground">{message}</p>
            )}
            {onRetry !== undefined && (
                <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
                    {retryLabel}
                </Button>
            )}
        </Card>
    );
}
