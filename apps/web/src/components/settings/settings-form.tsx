'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Field, SwitchField } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, apiPatch } from '@/lib/api';
import type { SettingsMap } from '@/lib/types';

/**
 * Whitelisted settings (API enforces the same whitelist + per-key value
 * validation; unknown keys are rejected with 400):
 * - ui.defaultPageSize  (1–100)   — listings page size default
 * - export.maxRows      (1–50000) — CSV export row cap
 * - scheduler.enabled   (boolean) — worker cron dispatcher toggle
 */
export function SettingsForm({ settings }: { settings: SettingsMap }) {
    const router = useRouter();
    const [defaultPageSize, setDefaultPageSize] = useState(
        typeof settings['ui.defaultPageSize'] === 'number' ? String(settings['ui.defaultPageSize']) : '25',
    );
    const [exportMaxRows, setExportMaxRows] = useState(
        typeof settings['export.maxRows'] === 'number' ? String(settings['export.maxRows']) : '50000',
    );
    const [schedulerEnabled, setSchedulerEnabled] = useState(
        typeof settings['scheduler.enabled'] === 'boolean' ? settings['scheduler.enabled'] : true,
    );
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [pending, setPending] = useState(false);

    const submit = async () => {
        const nextErrors: Record<string, string> = {};
        const pageSize = Number(defaultPageSize);
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
            nextErrors['ui.defaultPageSize'] = '1–100 arasında olmalı';
        }
        const maxRows = Number(exportMaxRows);
        if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 50_000) {
            nextErrors['export.maxRows'] = '1–50.000 arasında olmalı';
        }
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;

        setPending(true);
        try {
            await apiPatch('/api/settings', {
                'ui.defaultPageSize': pageSize,
                'export.maxRows': maxRows,
                'scheduler.enabled': schedulerEnabled,
            });
            toast.success('Ayarlar kaydedildi');
            router.refresh();
        } catch (err) {
            if (err instanceof ApiError && err.issues.length > 0) {
                const fieldErrors: Record<string, string> = {};
                for (const issue of err.issues) {
                    if (fieldErrors[issue.path] === undefined) fieldErrors[issue.path] = issue.message;
                }
                setErrors((prev) => ({ ...prev, ...fieldErrors }));
            }
            toast.error('Ayarlar kaydedilemedi', {
                description: err instanceof ApiError ? err.message : undefined,
            });
        } finally {
            setPending(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Uygulama Ayarları</CardTitle>
                <CardDescription>
                    Yalnızca tanımlı anahtarlar düzenlenebilir; API bilinmeyen anahtarları reddeder.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Field
                    label="Varsayılan Sayfa Boyutu (1–100)"
                    htmlFor="set-pageSize"
                    error={errors['ui.defaultPageSize']}
                    hint="İlan listesi sayfa başına kayıt"
                >
                    <Input
                        id="set-pageSize"
                        type="number"
                        min={1}
                        max={100}
                        value={defaultPageSize}
                        onChange={(e) => setDefaultPageSize(e.target.value)}
                        className="max-w-[200px]"
                    />
                </Field>
                <Field
                    label="CSV Dışa Aktarma Satır Üst Sınırı (1–50.000)"
                    htmlFor="set-maxRows"
                    error={errors['export.maxRows']}
                >
                    <Input
                        id="set-maxRows"
                        type="number"
                        min={1}
                        max={50000}
                        value={exportMaxRows}
                        onChange={(e) => setExportMaxRows(e.target.value)}
                        className="max-w-[200px]"
                    />
                </Field>
                <SwitchField
                    id="set-scheduler"
                    label="Zamanlayıcı aktif"
                    description="Cron ifadesi olan taramalar otomatik çalıştırılır"
                    checked={schedulerEnabled}
                    onCheckedChange={setSchedulerEnabled}
                />
                <div className="flex justify-end">
                    <Button onClick={() => void submit()} disabled={pending}>
                        {pending ? 'Kaydediliyor…' : 'Kaydet'}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
