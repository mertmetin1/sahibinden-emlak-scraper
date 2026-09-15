'use client';

import { useEffect } from 'react';

import { ErrorState } from '@/components/error-state';

export default function SessionsError({ error, reset }: { error: Error; reset: () => void }) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return <ErrorState title="Oturumlar yüklenemedi" message={error.message} onRetry={reset} />;
}
