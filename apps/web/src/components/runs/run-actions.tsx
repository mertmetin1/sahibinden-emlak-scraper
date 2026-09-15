'use client';

import { CircleX, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { ApiError, apiPost } from '@/lib/api';
import { API_ERROR_LABELS } from '@/lib/labels';
import { ACTIVE_RUN_STATUSES, type RunDto } from '@/lib/types';

const RETRYABLE: readonly string[] = ['FAILED', 'PARTIAL', 'CANCELLED'];

/** Run detail header actions: cancel (active runs) and retry (failed/partial/cancelled). */
export function RunActions({ run }: { run: RunDto }) {
    const router = useRouter();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [pending, setPending] = useState(false);

    const cancellable = ACTIVE_RUN_STATUSES.includes(run.status);
    const retryable = RETRYABLE.includes(run.status);

    if (!cancellable && !retryable) return null;

    const cancel = async () => {
        try {
            await apiPost(`/api/runs/${run.id}/cancel`);
            toast.success('İptal isteği gönderildi');
            router.refresh();
        } catch (err) {
            toast.error(API_ERROR_LABELS[err instanceof ApiError ? err.code : ''] ?? 'İptal başarısız', {
                description: err instanceof Error ? err.message : undefined,
            });
            throw err;
        }
    };

    const retry = async () => {
        setPending(true);
        try {
            const newRun = await apiPost<RunDto>(`/api/runs/${run.id}/retry`);
            toast.success('Yeniden deneme kuyruğa alındı');
            router.push(`/calistirmalar/${newRun.id}`);
        } catch (err) {
            toast.error(API_ERROR_LABELS[err instanceof ApiError ? err.code : ''] ?? 'Yeniden deneme başarısız', {
                description: err instanceof Error ? err.message : undefined,
            });
        } finally {
            setPending(false);
        }
    };

    return (
        <>
            {retryable && (
                <Button variant="outline" size="sm" onClick={() => void retry()} disabled={pending}>
                    <RotateCcw />
                    Yeniden Dene
                </Button>
            )}
            {cancellable && (
                <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)} disabled={pending}>
                    <CircleX />
                    İptal Et
                </Button>
            )}
            <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="Çalıştırmayı iptal et"
                description="Run kooperatif olarak durdurulur; işlenmekte olan sayfa tamamlanır, sayaçlar korunur."
                confirmLabel="İptal Et"
                destructive
                onConfirm={cancel}
            />
        </>
    );
}
