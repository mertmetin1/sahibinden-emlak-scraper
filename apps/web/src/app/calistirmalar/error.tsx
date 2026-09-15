'use client';

import { useEffect } from 'react';

import { ErrorState } from '@/components/error-state';

export default function RunsError({ error, reset }: { error: Error; reset: () => void }) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return <ErrorState title="Çalıştırmalar yüklenemedi" message={error.message} onRetry={reset} />;
}
