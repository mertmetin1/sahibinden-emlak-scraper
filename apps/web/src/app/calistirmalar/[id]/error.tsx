'use client';

import { useEffect } from 'react';

import { ErrorState } from '@/components/error-state';

export default function RunDetailError({ error, reset }: { error: Error; reset: () => void }) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return <ErrorState title="Run yüklenemedi" message={error.message} onRetry={reset} />;
}
