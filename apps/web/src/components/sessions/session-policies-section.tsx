'use client';

import { MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Field, SwitchField } from '@/components/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError, apiDelete, apiPatch, apiPost } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import type { SessionPolicyDto } from '@/lib/types';

interface PolicyFormState {
    name: string;
    poolSize: string;
    maxUsageCount: string;
    maxAgeMinutes: string;
    persistCookiesPerSession: boolean;
    proxyAffinity: boolean;
    retireOnNetworkFailures: boolean;
    failureThreshold: string;
}

const DEFAULT_FORM: PolicyFormState = {
    name: '',
    poolSize: '10',
    maxUsageCount: '50',
    maxAgeMinutes: '60',
    persistCookiesPerSession: true,
    proxyAffinity: false,
    retireOnNetworkFailures: true,
    failureThreshold: '3',
};

function fromPolicy(policy: SessionPolicyDto): PolicyFormState {
    return {
        name: policy.name,
        poolSize: String(policy.poolSize),
        maxUsageCount: String(policy.maxUsageCount),
        maxAgeMinutes: String(policy.maxAgeMinutes),
        persistCookiesPerSession: policy.persistCookiesPerSession,
        proxyAffinity: policy.proxyAffinity,
        retireOnNetworkFailures: policy.retireOnNetworkFailures,
        failureThreshold: String(policy.failureThreshold),
    };
}

/** Session policy CRUD (pool size, usage/age caps, affinity, retirement). */
export function SessionPoliciesSection({ policies }: { policies: SessionPolicyDto[] }) {
    const router = useRouter();
    const [dialog, setDialog] = useState<{ open: boolean; policy?: SessionPolicyDto }>({ open: false });
    const [deleteTarget, setDeleteTarget] = useState<SessionPolicyDto | null>(null);

    const remove = async (policy: SessionPolicyDto) => {
        try {
            await apiDelete(`/api/session-policies/${policy.id}`);
            toast.success('Oturum politikası silindi', { description: policy.name });
            router.refresh();
        } catch (err) {
            toast.error('Silme başarısız', { description: err instanceof ApiError ? err.message : undefined });
            throw err;
        }
    };

    return (
        <section className="space-y-3">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Oturum Politikaları</h2>
                <Button size="sm" onClick={() => setDialog({ open: true })}>
                    <Plus />
                    Yeni Politika
                </Button>
            </div>

            {policies.length === 0 ? (
                <EmptyState
                    icon={ShieldCheck}
                    title="Oturum politikası yok"
                    description="Politikalar tarayıcı oturum havuzunun boyutunu, yaşam süresini ve emeklilik kurallarını belirler."
                    action={
                        <Button size="sm" onClick={() => setDialog({ open: true })}>
                            <Plus />
                            İlk Politikayı Oluştur
                        </Button>
                    }
                />
            ) : (
                <Card>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Ad</TableHead>
                                    <TableHead className="text-right">Havuz</TableHead>
                                    <TableHead className="text-right">Maks. Kullanım</TableHead>
                                    <TableHead className="text-right">Maks. Yaş (dk)</TableHead>
                                    <TableHead>Çerez Kalıcılığı</TableHead>
                                    <TableHead>Proxy Yakınlığı</TableHead>
                                    <TableHead>Ağ Hatasında Emekli</TableHead>
                                    <TableHead className="text-right">Hata Eşiği</TableHead>
                                    <TableHead className="text-right">Tarama</TableHead>
                                    <TableHead className="w-[48px]" />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {policies.map((policy) => (
                                    <TableRow key={policy.id}>
                                        <TableCell className="font-medium">{policy.name}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatNumber(policy.poolSize)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatNumber(policy.maxUsageCount)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatNumber(policy.maxAgeMinutes)}</TableCell>
                                        <TableCell>
                                            <Badge variant={policy.persistCookiesPerSession ? 'success' : 'secondary'}>
                                                {policy.persistCookiesPerSession ? 'Evet' : 'Hayır'}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={policy.proxyAffinity ? 'info' : 'secondary'}>
                                                {policy.proxyAffinity ? 'Oturum Başına Sabit' : 'Yok'}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={policy.retireOnNetworkFailures ? 'warning' : 'secondary'}>
                                                {policy.retireOnNetworkFailures ? 'Evet' : 'Hayır'}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">{formatNumber(policy.failureThreshold)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatNumber(policy.assignedScanCount)}</TableCell>
                                        <TableCell>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon-sm">
                                                        <MoreHorizontal />
                                                        <span className="sr-only">Aksiyonlar</span>
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuItem onClick={() => setDialog({ open: true, policy })}>
                                                        <Pencil />
                                                        Düzenle
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem
                                                        className="text-destructive focus:text-destructive"
                                                        onClick={() => setDeleteTarget(policy)}
                                                    >
                                                        <Trash2 />
                                                        Sil
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            <PolicyDialog
                key={dialog.policy?.id ?? 'new'}
                open={dialog.open}
                onOpenChange={(open) => setDialog(open ? dialog : { open: false })}
                policy={dialog.policy}
            />
            <ConfirmDialog
                open={deleteTarget !== null}
                onOpenChange={(open) => !open && setDeleteTarget(null)}
                title="Oturum politikasını sil"
                description={
                    deleteTarget !== null
                        ? `"${deleteTarget.name}" silinecek; kullanan ${deleteTarget.assignedScanCount} tarama varsayılana düşer.`
                        : undefined
                }
                confirmLabel="Sil"
                destructive
                onConfirm={async () => {
                    if (deleteTarget !== null) await remove(deleteTarget);
                }}
            />
        </section>
    );
}

function PolicyDialog({
    open,
    onOpenChange,
    policy,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    policy?: SessionPolicyDto;
}) {
    const router = useRouter();
    const [form, setForm] = useState<PolicyFormState>(() => (policy !== undefined ? fromPolicy(policy) : DEFAULT_FORM));
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [pending, setPending] = useState(false);

    const set = <K extends keyof PolicyFormState>(key: K, value: PolicyFormState[K]) =>
        setForm((prev) => ({ ...prev, [key]: value }));

    const submit = async () => {
        const nextErrors: Record<string, string> = {};
        if (form.name.trim() === '') nextErrors.name = 'Ad zorunludur';
        const rules: Array<[keyof PolicyFormState, string, number, number]> = [
            ['poolSize', 'Havuz boyutu', 1, 100],
            ['maxUsageCount', 'Maks. kullanım', 1, 10000],
            ['maxAgeMinutes', 'Maks. yaş', 1, 1440],
            ['failureThreshold', 'Hata eşiği', 1, 20],
        ];
        for (const [key, label, min, max] of rules) {
            const n = Number(form[key]);
            if (!Number.isInteger(n) || n < min || n > max) nextErrors[key] = `${label} ${min}–${max} arasında olmalı`;
        }
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;

        const payload = {
            name: form.name.trim(),
            poolSize: Number(form.poolSize),
            maxUsageCount: Number(form.maxUsageCount),
            maxAgeMinutes: Number(form.maxAgeMinutes),
            persistCookiesPerSession: form.persistCookiesPerSession,
            proxyAffinity: form.proxyAffinity,
            retireOnNetworkFailures: form.retireOnNetworkFailures,
            failureThreshold: Number(form.failureThreshold),
        };

        setPending(true);
        try {
            if (policy === undefined) {
                await apiPost('/api/session-policies', payload);
                toast.success('Oturum politikası oluşturuldu');
            } else {
                await apiPatch(`/api/session-policies/${policy.id}`, payload);
                toast.success('Oturum politikası güncellendi');
            }
            onOpenChange(false);
            router.refresh();
        } catch (err) {
            if (err instanceof ApiError && err.issues.length > 0) {
                const fieldErrors: Record<string, string> = {};
                for (const issue of err.issues) {
                    const field = issue.path.split('.')[0] ?? issue.path;
                    if (fieldErrors[field] === undefined) fieldErrors[field] = issue.message;
                }
                setErrors((prev) => ({ ...prev, ...fieldErrors }));
            }
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
                    <DialogTitle>{policy === undefined ? 'Yeni Oturum Politikası' : 'Politikayı Düzenle'}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    <Field label="Politika Adı" htmlFor="sp-name" required error={errors.name}>
                        <Input id="sp-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Havuz Boyutu (1–100)" htmlFor="sp-pool" error={errors.poolSize}>
                            <Input
                                id="sp-pool"
                                type="number"
                                min={1}
                                max={100}
                                value={form.poolSize}
                                onChange={(e) => set('poolSize', e.target.value)}
                            />
                        </Field>
                        <Field label="Maks. Kullanım" htmlFor="sp-usage" error={errors.maxUsageCount}>
                            <Input
                                id="sp-usage"
                                type="number"
                                min={1}
                                max={10000}
                                value={form.maxUsageCount}
                                onChange={(e) => set('maxUsageCount', e.target.value)}
                            />
                        </Field>
                        <Field label="Maks. Yaş (dk)" htmlFor="sp-age" error={errors.maxAgeMinutes}>
                            <Input
                                id="sp-age"
                                type="number"
                                min={1}
                                max={1440}
                                value={form.maxAgeMinutes}
                                onChange={(e) => set('maxAgeMinutes', e.target.value)}
                            />
                        </Field>
                        <Field label="Hata Eşiği (1–20)" htmlFor="sp-threshold" error={errors.failureThreshold}>
                            <Input
                                id="sp-threshold"
                                type="number"
                                min={1}
                                max={20}
                                value={form.failureThreshold}
                                onChange={(e) => set('failureThreshold', e.target.value)}
                            />
                        </Field>
                    </div>
                    <SwitchField
                        id="sp-persist"
                        label="Oturum başına çerez kalıcılığı"
                        checked={form.persistCookiesPerSession}
                        onCheckedChange={(v) => set('persistCookiesPerSession', v)}
                    />
                    <SwitchField
                        id="sp-affinity"
                        label="Proxy yakınlığı"
                        description="Oturum tek bir proxy endpoint'ine sabitlenir"
                        checked={form.proxyAffinity}
                        onCheckedChange={(v) => set('proxyAffinity', v)}
                    />
                    <SwitchField
                        id="sp-retire"
                        label="Ağ hatalarında emekliye ayır"
                        checked={form.retireOnNetworkFailures}
                        onCheckedChange={(v) => set('retireOnNetworkFailures', v)}
                    />
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
