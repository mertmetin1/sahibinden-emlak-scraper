'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Field } from '@/components/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPost } from '@/lib/api';
import type { ProxyImportResultDto } from '@/lib/types';

/**
 * Bulk endpoint import. Shows the API's per-line result: imported count and
 * masked failure rows (the API never echoes credentials back).
 */
export function BulkImportDialog({
    open,
    onOpenChange,
    profileId,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    profileId: string;
}) {
    const router = useRouter();
    const [text, setText] = useState('');
    const [result, setResult] = useState<ProxyImportResultDto | null>(null);
    const [pending, setPending] = useState(false);

    const submit = async () => {
        if (text.trim() === '') return;
        setPending(true);
        setResult(null);
        try {
            const res = await apiPost<ProxyImportResultDto>(`/api/proxy-profiles/${profileId}/endpoints/bulk`, { text });
            setResult(res);
            if (res.failed.length === 0) {
                toast.success(`${res.imported} endpoint içe aktarıldı`);
            } else {
                toast.warning(`${res.imported} içe aktarıldı, ${res.failed.length} satır başarısız`);
            }
            router.refresh();
        } catch (err) {
            toast.error('İçe aktarma başarısız', {
                description: err instanceof ApiError ? err.message : undefined,
            });
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Toplu Endpoint İçe Aktarma</DialogTitle>
                    <DialogDescription>
                        Her satıra bir proxy: <code>protocol://user:pass@host:port</code>,{' '}
                        <code>host:port:user:pass</code> veya <code>host:port</code>. `#` ile başlayan satırlar yorumdur.
                    </DialogDescription>
                </DialogHeader>
                <Field label="Proxy Listesi" htmlFor="bulk-text">
                    <Textarea
                        id="bulk-text"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={8}
                        className="font-mono text-xs"
                        placeholder={'http://user:pass@1.2.3.4:8080\nsocks5://5.6.7.8:1080'}
                    />
                </Field>
                {result !== null && (
                    <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
                        <div className="flex items-center gap-2">
                            <Badge variant="success">{result.imported} içe aktarıldı</Badge>
                            {result.failed.length > 0 && <Badge variant="destructive">{result.failed.length} başarısız</Badge>}
                        </div>
                        {result.failed.length > 0 && (
                            <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                                {result.failed.map((failure, index) => (
                                    <li key={index} className="text-destructive">
                                        <span className="font-mono">{failure.line}</span> — {failure.error}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        Kapat
                    </Button>
                    <Button onClick={() => void submit()} disabled={pending || text.trim() === ''}>
                        {pending ? 'İçe Aktarılıyor…' : 'İçe Aktar'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
