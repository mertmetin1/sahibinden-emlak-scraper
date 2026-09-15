'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Field, SwitchField } from '@/components/field';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { ApiError, apiPatch, apiPost } from '@/lib/api';
import type { ProxyProfileSummaryDto, ProxyStrategy } from '@/lib/types';

/** Create/edit proxy profile dialog. */
export function ProfileDialog({
    open,
    onOpenChange,
    profile,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Undefined = create mode. */
    profile?: ProxyProfileSummaryDto;
}) {
    const router = useRouter();
    const [name, setName] = useState(profile?.name ?? '');
    const [strategy, setStrategy] = useState<ProxyStrategy>(profile?.strategy ?? 'ROUND_ROBIN');
    const [enabled, setEnabled] = useState(profile?.enabled ?? true);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const submit = async () => {
        if (name.trim() === '') {
            setError('Ad zorunludur');
            return;
        }
        setPending(true);
        setError(null);
        try {
            if (profile === undefined) {
                await apiPost('/api/proxy-profiles', { name: name.trim(), strategy, enabled });
                toast.success('Proxy profili oluşturuldu');
            } else {
                await apiPatch(`/api/proxy-profiles/${profile.id}`, { name: name.trim(), strategy, enabled });
                toast.success('Proxy profili güncellendi');
            }
            onOpenChange(false);
            router.refresh();
        } catch (err) {
            toast.error('Kaydetme başarısız', {
                description: err instanceof ApiError ? err.message : undefined,
            });
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{profile === undefined ? 'Yeni Proxy Profili' : 'Profili Düzenle'}</DialogTitle>
                    <DialogDescription>
                        Strateji: Sıralı her istekte sonraki endpoint; Oturum Sabit oturum boyunca aynı endpoint.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <Field label="Profil Adı" htmlFor="pp-name" required error={error ?? undefined}>
                        <Input
                            id="pp-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="ör. Konut Proxy Havuzu"
                        />
                    </Field>
                    <Field label="Strateji">
                        <Select value={strategy} onValueChange={(v) => setStrategy(v as ProxyStrategy)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="ROUND_ROBIN">Sıralı (Round Robin)</SelectItem>
                                <SelectItem value="SESSION_STICKY">Oturum Sabit</SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>
                    <SwitchField id="pp-enabled" label="Aktif" checked={enabled} onCheckedChange={setEnabled} />
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        Vazgeç
                    </Button>
                    <Button onClick={() => void submit()} disabled={pending}>
                        {pending ? 'Kaydediliyor…' : 'Kaydet'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
