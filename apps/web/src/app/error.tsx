'use client';

import { useEffect } from 'react';

import { ErrorState } from '@/components/error-state';

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <ErrorState
            title="Sayfa yüklenemedi"
            message={error.message !== '' ? error.message : 'API erişilemiyor olabilir.'}
            onRetry={reset}
        />
    );
}
