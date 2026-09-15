'use client';

import { useEffect } from 'react';

import { ErrorState } from '@/components/error-state';

export default function ProxiesError({ error, reset }: { error: Error; reset: () => void }) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return <ErrorState title="Proxy'ler yüklenemedi" message={error.message} onRetry={reset} />;
}
