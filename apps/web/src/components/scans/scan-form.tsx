'use client';

import { Copy, FlaskConical, Play, Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Field, SwitchField } from '@/components/field';
import { ChipsInput } from '@/components/scans/chips-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPatch, apiPost } from '@/lib/api';
import { describeCron } from '@/lib/cron';
import {
    API_ERROR_LABELS,
    COOKIE_VALIDATION_LABELS,
    COOKIE_VALIDATION_TONES,
    PROXY_HEALTH_LABELS,
    PROXY_STRATEGY_LABELS,
} from '@/lib/labels';
import type {
    BrowserMode,
    CookieProfileDto,
    ProxyHealth,
    ProxyProfileSummaryDto,
    RunDto,
    ScanDto,
    SessionPolicyDto,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
    name: string;
    description: string;
    startUrlsText: string;
    allowedDomains: string[];
    browserMode: BrowserMode;
    cdpUrl: string;
    includeDetails: boolean;
    incrementalMode: boolean;
    maxItems: string;
    maxPages: string;
    maxConcurrency: string;
    navigationTimeoutSeconds: string;
    requestHandlerTimeoutSeconds: string;
    maxRequestRetries: string;
    delayMinMs: string;
    delayMaxMs: string;
    proxyProfileId: string;
    cookieProfileId: string;
    sessionPolicyId: string;
    humanInTheLoop: boolean;
    enabled: boolean;
    schedule: string;
    timezone: string;
    debugMode: boolean;
    storeRawHtml: boolean;
    storeScreenshotsOnFailure: boolean;
    staleDetectionEnabled: boolean;
    staleAfterSuccessfulRuns: string;
}

const DEFAULTS: FormState = {
    name: '',
    description: '',
    startUrlsText: '',
    allowedDomains: ['sahibinden.com', 'www.sahibinden.com'],
    browserMode: 'cdp',
    cdpUrl: '',
    includeDetails: true,
    incrementalMode: false,
    maxItems: '',
    maxPages: '',
    maxConcurrency: '3',
    navigationTimeoutSeconds: '90',
    requestHandlerTimeoutSeconds: '180',
    maxRequestRetries: '8',
    delayMinMs: '2000',
    delayMaxMs: '5000',
    proxyProfileId: '',
    cookieProfileId: '',
    sessionPolicyId: '',
    humanInTheLoop: true,
    enabled: true,
    schedule: '',
    timezone: 'Europe/Istanbul',
    debugMode: false,
    storeRawHtml: false,
    storeScreenshotsOnFailure: true,
    staleDetectionEnabled: true,
    staleAfterSuccessfulRuns: '3',
};

function fromScan(scan: ScanDto): FormState {
    return {
        name: scan.name,
        description: scan.description,
        startUrlsText: scan.startUrls.join('\n'),
        allowedDomains: scan.allowedDomains,
        browserMode: scan.browserMode,
        cdpUrl: scan.cdpUrl ?? '',
        includeDetails: scan.includeDetails,
        incrementalMode: scan.incrementalMode,
        maxItems: scan.maxItems !== null ? String(scan.maxItems) : '',
        maxPages: scan.maxPages !== null ? String(scan.maxPages) : '',
        maxConcurrency: String(scan.maxConcurrency),
        navigationTimeoutSeconds: String(scan.navigationTimeoutSeconds),
        requestHandlerTimeoutSeconds: String(scan.requestHandlerTimeoutSeconds),
        maxRequestRetries: String(scan.maxRequestRetries),
        delayMinMs: String(scan.delayMinMs),
        delayMaxMs: String(scan.delayMaxMs),
        proxyProfileId: scan.proxyProfileId ?? '',
        cookieProfileId: scan.cookieProfileId ?? '',
        sessionPolicyId: scan.sessionPolicyId ?? '',
        humanInTheLoop: scan.humanInTheLoop,
        enabled: scan.enabled,
        schedule: scan.schedule ?? '',
        timezone: scan.timezone,
        debugMode: scan.debugMode,
        storeRawHtml: scan.storeRawHtml,
        storeScreenshotsOnFailure: scan.storeScreenshotsOnFailure,
        staleDetectionEnabled: scan.staleDetectionEnabled,
        staleAfterSuccessfulRuns: String(scan.staleAfterSuccessfulRuns),
    };
}

const TIMEZONES = [
    'Europe/Istanbul',
    'Europe/London',
    'Europe/Berlin',
    'Europe/Paris',
    'Europe/Moscow',
    'Asia/Dubai',
    'Asia/Tokyo',
    'America/New_York',
    'America/Chicago',
    'America/Los_Angeles',
    'UTC',
];

/** Field name → owning tab, used to jump to the first API validation error. */
const FIELD_TABS: Record<string, string> = {
    startUrls: 'hedefler',
    allowedDomains: 'hedefler',
    browserMode: 'hedefler',
    cdpUrl: 'hedefler',
    includeDetails: 'cikarim',
    incrementalMode: 'cikarim',
    maxItems: 'limitler',
    maxPages: 'limitler',
    maxConcurrency: 'limitler',
    navigationTimeoutSeconds: 'limitler',
    requestHandlerTimeoutSeconds: 'limitler',
    maxRequestRetries: 'limitler',
    delayMinMs: 'limitler',
    delayMaxMs: 'limitler',
    proxyProfileId: 'proxy',
    cookieProfileId: 'oturum',
    sessionPolicyId: 'oturum',
    humanInTheLoop: 'oturum',
    enabled: 'zamanlama',
    schedule: 'zamanlama',
    timezone: 'zamanlama',
    debugMode: 'tanilama',
    storeRawHtml: 'tanilama',
    storeScreenshotsOnFailure: 'tanilama',
    staleDetectionEnabled: 'tanilama',
    staleAfterSuccessfulRuns: 'tanilama',
};

const NONE = '__none__'; // Radix Select rejects empty-string item values.

// ---------------------------------------------------------------------------
// Validation + payload
// ---------------------------------------------------------------------------

function parseIntField(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isInteger(n) ? n : Number.NaN;
}

function isValidUrl(value: string): boolean {
    try {
        new URL(value);
        return true;
    } catch {
        return false;
    }
}

function validate(state: FormState): Record<string, string> {
    const errors: Record<string, string> = {};
    if (state.name.trim() === '') errors.name = 'Ad zorunludur';

    const urls = state.startUrlsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    if (urls.length === 0) {
        errors.startUrls = 'En az bir hedef URL gerekli';
    } else if (urls.some((u) => !isValidUrl(u))) {
        errors.startUrls = 'Geçersiz URL var — her satıra tam bir URL yazın (https://…)';
    }

    if (state.allowedDomains.length === 0) errors.allowedDomains = 'En az bir izinli alan adı gerekli';

    if (state.browserMode === 'cdp') {
        if (state.cdpUrl.trim() === '') errors.cdpUrl = 'CDP modu için CDP URL zorunludur';
        else if (!isValidUrl(state.cdpUrl.trim())) errors.cdpUrl = 'Geçerli bir URL girin';
    }

    const intRules: Array<[keyof FormState, string, number, number, boolean]> = [
        ['maxItems', 'Maks. ilan', 1, Number.MAX_SAFE_INTEGER, true],
        ['maxPages', 'Maks. sayfa', 1, Number.MAX_SAFE_INTEGER, true],
        ['maxConcurrency', 'Eşzamanlılık', 1, 10, false],
        ['navigationTimeoutSeconds', 'Gezinme zaman aşımı', 5, 300, false],
        ['requestHandlerTimeoutSeconds', 'İstek zaman aşımı', 30, 600, false],
        ['maxRequestRetries', 'Yeniden deneme', 0, 20, false],
        ['delayMinMs', 'Min. bekleme', 0, Number.MAX_SAFE_INTEGER, false],
        ['delayMaxMs', 'Maks. bekleme', 0, Number.MAX_SAFE_INTEGER, false],
        ['staleAfterSuccessfulRuns', 'Stale eşiği', 1, 20, false],
    ];
    for (const [key, label, min, max, nullable] of intRules) {
        const raw = state[key] as string;
        if (raw.trim() === '') {
            if (!nullable) errors[key] = `${label} zorunludur`;
            continue;
        }
        const n = Number(raw);
        if (!Number.isInteger(n) || n < min || n > max) {
            errors[key] =
                max === Number.MAX_SAFE_INTEGER
                    ? `${label} en az ${min} olmalı`
                    : `${label} ${min}–${max} arasında olmalı`;
        }
    }

    const delayMin = parseIntField(state.delayMinMs);
    const delayMax = parseIntField(state.delayMaxMs);
    if (delayMin !== null && !Number.isNaN(delayMin) && delayMax !== null && !Number.isNaN(delayMax) && delayMax < delayMin) {
        errors.delayMaxMs = 'Maks. bekleme, min. beklemeden küçük olamaz';
    }

    if (state.schedule.trim() !== '' && state.schedule.trim().split(/\s+/).length !== 5) {
        errors.schedule = 'Cron ifadesi 5 alandan oluşmalı (ör. 0 9 * * *)';
    }

    return errors;
}

function toPayload(state: FormState): Record<string, unknown> {
    const startUrls = state.startUrlsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    return {
        name: state.name.trim(),
        description: state.description.trim(),
        enabled: state.enabled,
        startUrls,
        allowedDomains: state.allowedDomains,
        browserMode: state.browserMode,
        cdpUrl: state.cdpUrl.trim() === '' ? null : state.cdpUrl.trim(),
        includeDetails: state.includeDetails,
        incrementalMode: state.incrementalMode,
        maxItems: parseIntField(state.maxItems),
        maxPages: parseIntField(state.maxPages),
        maxConcurrency: parseIntField(state.maxConcurrency),
        navigationTimeoutSeconds: parseIntField(state.navigationTimeoutSeconds),
        requestHandlerTimeoutSeconds: parseIntField(state.requestHandlerTimeoutSeconds),
        maxRequestRetries: parseIntField(state.maxRequestRetries),
        delayMinMs: parseIntField(state.delayMinMs),
        delayMaxMs: parseIntField(state.delayMaxMs),
        proxyProfileId: state.proxyProfileId === '' ? null : state.proxyProfileId,
        cookieProfileId: state.cookieProfileId === '' ? null : state.cookieProfileId,
        sessionPolicyId: state.sessionPolicyId === '' ? null : state.sessionPolicyId,
        humanInTheLoop: state.humanInTheLoop,
        schedule: state.schedule.trim() === '' ? null : state.schedule.trim(),
        timezone: state.timezone,
        debugMode: state.debugMode,
        storeRawHtml: state.storeRawHtml,
        storeScreenshotsOnFailure: state.storeScreenshotsOnFailure,
        staleDetectionEnabled: state.staleDetectionEnabled,
        staleAfterSuccessfulRuns: parseIntField(state.staleAfterSuccessfulRuns),
    };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScanForm({
    mode,
    initial,
    proxyProfiles,
    cookieProfiles,
    sessionPolicies,
}: {
    mode: 'create' | 'edit';
    initial?: ScanDto;
    proxyProfiles: ProxyProfileSummaryDto[];
    cookieProfiles: CookieProfileDto[];
    sessionPolicies: SessionPolicyDto[];
}) {
    const router = useRouter();
    const [state, setState] = useState<FormState>(() => (initial !== undefined ? fromScan(initial) : DEFAULTS));
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [activeTab, setActiveTab] = useState('hedefler');
    const [pending, setPending] = useState<'save' | 'test' | 'run' | 'duplicate' | 'toggle' | null>(null);

    const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
        setState((prev) => ({ ...prev, [key]: value }));
        // Errors are keyed by API field name; state keys can differ
        // (startUrlsText → startUrls) — clear both.
        const errorKeys = key === 'startUrlsText' ? [key, 'startUrls'] : [key];
        setErrors((prev) => {
            if (!errorKeys.some((k) => prev[k] !== undefined)) return prev;
            const next = { ...prev };
            for (const k of errorKeys) delete next[k];
            return next;
        });
    };

    const selectedProxy = useMemo(
        () => proxyProfiles.find((p) => p.id === state.proxyProfileId),
        [proxyProfiles, state.proxyProfileId],
    );
    const selectedCookie = useMemo(
        () => cookieProfiles.find((p) => p.id === state.cookieProfileId),
        [cookieProfiles, state.cookieProfileId],
    );
    const selectedPolicy = useMemo(
        () => sessionPolicies.find((p) => p.id === state.sessionPolicyId),
        [sessionPolicies, state.sessionPolicyId],
    );

    const timezoneOptions = TIMEZONES.includes(state.timezone) ? TIMEZONES : [state.timezone, ...TIMEZONES];
    const cronDescription = describeCron(state.schedule);

    /** Validates, then creates or updates; returns the scan id, or null on failure. */
    const save = async (): Promise<string | null> => {
        const clientErrors = validate(state);
        if (Object.keys(clientErrors).length > 0) {
            setErrors(clientErrors);
            const firstField = Object.keys(clientErrors)[0];
            const tab = firstField !== undefined ? FIELD_TABS[firstField] : undefined;
            if (tab !== undefined) setActiveTab(tab);
            toast.error('Formda hatalar var', { description: 'İşaretli alanları düzeltin.' });
            return null;
        }
        const payload = toPayload(state);
        try {
            if (mode === 'create') {
                const created = await apiPost<ScanDto>('/api/scans', payload);
                return created.id;
            }
            if (initial === undefined) return null;
            await apiPatch<ScanDto>(`/api/scans/${initial.id}`, payload);
            return initial.id;
        } catch (err) {
            if (err instanceof ApiError && err.status === 400 && err.issues.length > 0) {
                // Map API 400 issues back to fields (path may be 'startUrls.0').
                const fieldErrors: Record<string, string> = {};
                for (const issue of err.issues) {
                    const field = issue.path.split('.')[0] ?? issue.path;
                    if (fieldErrors[field] === undefined) fieldErrors[field] = issue.message;
                }
                setErrors((prev) => ({ ...prev, ...fieldErrors }));
                const firstField = Object.keys(fieldErrors)[0];
                const tab = firstField !== undefined ? FIELD_TABS[firstField] : undefined;
                if (tab !== undefined) setActiveTab(tab);
            }
            toast.error(API_ERROR_LABELS[err instanceof ApiError ? err.code : ''] ?? 'Kaydetme başarısız', {
                description: err instanceof Error ? err.message : undefined,
            });
            return null;
        }
    };

    const runAction = async (kind: 'save' | 'test' | 'run') => {
        setPending(kind);
        try {
            const id = await save();
            if (id === null) return;
            if (kind === 'save') {
                toast.success(mode === 'create' ? 'Tarama oluşturuldu' : 'Tarama kaydedildi');
                if (mode === 'create') router.push(`/taramalar/${id}`);
                else router.refresh();
                return;
            }
            const run = await apiPost<RunDto>(`/api/scans/${id}/${kind}`);
            toast.success(kind === 'test' ? 'Test çalıştırması başlatıldı' : 'Çalıştırma başlatıldı');
            router.push(`/calistirmalar/${run.id}`);
        } catch (err) {
            toast.error(API_ERROR_LABELS[err instanceof ApiError ? err.code : ''] ?? 'İşlem başarısız', {
                description: err instanceof Error ? err.message : undefined,
            });
        } finally {
            setPending(null);
        }
    };

    const duplicate = async () => {
        if (initial === undefined) return;
        setPending('duplicate');
        try {
            const copy = await apiPost<ScanDto>(`/api/scans/${initial.id}/duplicate`);
            toast.success('Tarama çoğaltıldı', { description: `"${copy.name}" devre dışı oluşturuldu` });
            router.push(`/taramalar/${copy.id}`);
        } catch (err) {
            toast.error('Çoğaltma başarısız', {
                description: err instanceof Error ? err.message : undefined,
            });
        } finally {
            setPending(null);
        }
    };

    const toggleEnabled = async () => {
        if (initial === undefined) return;
        setPending('toggle');
        try {
            await apiPost(`/api/scans/${initial.id}/toggle`, { enabled: !state.enabled });
            set('enabled', !state.enabled);
            toast.success(state.enabled ? 'Tarama devre dışı bırakıldı' : 'Tarama aktifleştirildi');
            router.refresh();
        } catch (err) {
            toast.error('Durum değiştirilemedi', {
                description: err instanceof Error ? err.message : undefined,
            });
        } finally {
            setPending(null);
        }
    };

    return (
        <div className="space-y-4 pb-20">
            <Card>
                <CardHeader>
                    <CardTitle>Genel</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                    <Field label="Tarama Adı" htmlFor="sf-name" required error={errors.name}>
                        <Input
                            id="sf-name"
                            value={state.name}
                            onChange={(e) => set('name', e.target.value)}
                            placeholder="ör. Kadıköy Satılık Daireler"
                            aria-invalid={errors.name !== undefined}
                        />
                    </Field>
                    <Field label="Açıklama" htmlFor="sf-description" error={errors.description}>
                        <Input
                            id="sf-description"
                            value={state.description}
                            onChange={(e) => set('description', e.target.value)}
                            placeholder="Opsiyonel"
                        />
                    </Field>
                </CardContent>
            </Card>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="flex-wrap">
                    <TabsTrigger value="hedefler">Hedefler</TabsTrigger>
                    <TabsTrigger value="cikarim">Çıkarım</TabsTrigger>
                    <TabsTrigger value="limitler">Limitler</TabsTrigger>
                    <TabsTrigger value="proxy">Proxy</TabsTrigger>
                    <TabsTrigger value="oturum">Oturum</TabsTrigger>
                    <TabsTrigger value="zamanlama">Zamanlama</TabsTrigger>
                    <TabsTrigger value="tanilama">Tanılama</TabsTrigger>
                </TabsList>

                <TabsContent value="hedefler">
                    <Card>
                        <CardHeader>
                            <CardTitle>Hedefler</CardTitle>
                            <CardDescription>
                                Kategori veya ilan URL&apos;leri; URL biçimi (…/detay) sayfa tipini belirler.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <Field
                                label="Başlangıç URL'leri"
                                htmlFor="sf-startUrls"
                                required
                                error={errors.startUrls}
                                hint="Her satıra bir URL"
                            >
                                <Textarea
                                    id="sf-startUrls"
                                    value={state.startUrlsText}
                                    onChange={(e) => set('startUrlsText', e.target.value)}
                                    placeholder={'https://www.sahibinden.com/satilik-daire/istanbul-kadikoy\nhttps://…'}
                                    rows={4}
                                    className="font-mono text-xs"
                                    aria-invalid={errors.startUrls !== undefined}
                                />
                            </Field>
                            <Field
                                label="İzinli Alan Adları"
                                required
                                error={errors.allowedDomains}
                                hint="SSRF koruması: yalnızca bu alan adları taranır"
                            >
                                <ChipsInput
                                    values={state.allowedDomains}
                                    onChange={(v) => set('allowedDomains', v)}
                                    placeholder="sahibinden.com"
                                />
                            </Field>
                            <div className="grid gap-4 md:grid-cols-2">
                                <Field label="Tarayıcı Modu" error={errors.browserMode}>
                                    <Select
                                        value={state.browserMode}
                                        onValueChange={(v) => set('browserMode', v as BrowserMode)}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="cdp">CDP — kendi Chrome&apos;unuza bağlan</SelectItem>
                                            <SelectItem value="managed">Managed — worker Chromium başlatır</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </Field>
                                {state.browserMode === 'cdp' && (
                                    <Field
                                        label="CDP URL"
                                        htmlFor="sf-cdpUrl"
                                        required
                                        error={errors.cdpUrl}
                                        hint="ör. http://host.docker.internal:9222"
                                    >
                                        <Input
                                            id="sf-cdpUrl"
                                            value={state.cdpUrl}
                                            onChange={(e) => set('cdpUrl', e.target.value)}
                                            placeholder="http://127.0.0.1:9222"
                                            className="font-mono text-xs"
                                            aria-invalid={errors.cdpUrl !== undefined}
                                        />
                                    </Field>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="cikarim">
                    <Card>
                        <CardHeader>
                            <CardTitle>Çıkarım</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <SwitchField
                                id="sf-includeDetails"
                                label="Detay sayfalarını çek"
                                description="Keşfedilen her ilan için detay sayfası da ziyaret edilir"
                                checked={state.includeDetails}
                                onCheckedChange={(v) => set('includeDetails', v)}
                            />
                            <SwitchField
                                id="sf-incrementalMode"
                                label="Artımlı mod"
                                description="Tamamen bilinen ilanlardan oluşan bir sayfada sayfalama durur (stale tespiti bu run'larda yapılmaz)"
                                checked={state.incrementalMode}
                                onCheckedChange={(v) => set('incrementalMode', v)}
                            />
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="limitler">
                    <Card>
                        <CardHeader>
                            <CardTitle>Limitler</CardTitle>
                            <CardDescription>Boş bırakılan üst sınırlar &quot;sınırsız&quot; demektir.</CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                            <Field label="Maks. İlan" htmlFor="sf-maxItems" error={errors.maxItems}>
                                <Input
                                    id="sf-maxItems"
                                    type="number"
                                    min={1}
                                    value={state.maxItems}
                                    onChange={(e) => set('maxItems', e.target.value)}
                                    placeholder="Sınırsız"
                                    aria-invalid={errors.maxItems !== undefined}
                                />
                            </Field>
                            <Field label="Maks. Sayfa" htmlFor="sf-maxPages" error={errors.maxPages}>
                                <Input
                                    id="sf-maxPages"
                                    type="number"
                                    min={1}
                                    value={state.maxPages}
                                    onChange={(e) => set('maxPages', e.target.value)}
                                    placeholder="Sınırsız"
                                    aria-invalid={errors.maxPages !== undefined}
                                />
                            </Field>
                            <Field label="Eşzamanlılık (1–10)" htmlFor="sf-maxConcurrency" error={errors.maxConcurrency}>
                                <Input
                                    id="sf-maxConcurrency"
                                    type="number"
                                    min={1}
                                    max={10}
                                    value={state.maxConcurrency}
                                    onChange={(e) => set('maxConcurrency', e.target.value)}
                                    aria-invalid={errors.maxConcurrency !== undefined}
                                />
                            </Field>
                            <Field
                                label="Gezinme Zaman Aşımı (sn)"
                                htmlFor="sf-navTimeout"
                                error={errors.navigationTimeoutSeconds}
                            >
                                <Input
                                    id="sf-navTimeout"
                                    type="number"
                                    min={5}
                                    max={300}
                                    value={state.navigationTimeoutSeconds}
                                    onChange={(e) => set('navigationTimeoutSeconds', e.target.value)}
                                    aria-invalid={errors.navigationTimeoutSeconds !== undefined}
                                />
                            </Field>
                            <Field
                                label="İstek Zaman Aşımı (sn)"
                                htmlFor="sf-handlerTimeout"
                                error={errors.requestHandlerTimeoutSeconds}
                            >
                                <Input
                                    id="sf-handlerTimeout"
                                    type="number"
                                    min={30}
                                    max={600}
                                    value={state.requestHandlerTimeoutSeconds}
                                    onChange={(e) => set('requestHandlerTimeoutSeconds', e.target.value)}
                                    aria-invalid={errors.requestHandlerTimeoutSeconds !== undefined}
                                />
                            </Field>
                            <Field
                                label="Yeniden Deneme (0–20)"
                                htmlFor="sf-retries"
                                error={errors.maxRequestRetries}
                            >
                                <Input
                                    id="sf-retries"
                                    type="number"
                                    min={0}
                                    max={20}
                                    value={state.maxRequestRetries}
                                    onChange={(e) => set('maxRequestRetries', e.target.value)}
                                    aria-invalid={errors.maxRequestRetries !== undefined}
                                />
                            </Field>
                            <Field label="Min. Bekleme (ms)" htmlFor="sf-delayMin" error={errors.delayMinMs}>
                                <Input
                                    id="sf-delayMin"
                                    type="number"
                                    min={0}
                                    value={state.delayMinMs}
                                    onChange={(e) => set('delayMinMs', e.target.value)}
                                    aria-invalid={errors.delayMinMs !== undefined}
                                />
                            </Field>
                            <Field label="Maks. Bekleme (ms)" htmlFor="sf-delayMax" error={errors.delayMaxMs}>
                                <Input
                                    id="sf-delayMax"
                                    type="number"
                                    min={0}
                                    value={state.delayMaxMs}
                                    onChange={(e) => set('delayMaxMs', e.target.value)}
                                    aria-invalid={errors.delayMaxMs !== undefined}
                                />
                            </Field>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="proxy">
                    <Card>
                        <CardHeader>
                            <CardTitle>Proxy</CardTitle>
                            <CardDescription>
                                Yalnızca Managed modda uygulanır; CDP modunda kullanıcının kendi ağı kullanılır.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <Field label="Proxy Profili" error={errors.proxyProfileId}>
                                <Select
                                    value={state.proxyProfileId === '' ? NONE : state.proxyProfileId}
                                    onValueChange={(v) => set('proxyProfileId', v === NONE ? '' : v)}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NONE}>Yok (doğrudan bağlantı)</SelectItem>
                                        {proxyProfiles.map((profile) => (
                                            <SelectItem key={profile.id} value={profile.id}>
                                                {profile.name} ({profile.endpointCount} endpoint)
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            {selectedProxy !== undefined && (
                                <div className="rounded-md border bg-muted/40 p-3 text-sm">
                                    <div className="mb-2 flex items-center gap-2">
                                        <span className="font-medium">{selectedProxy.name}</span>
                                        <Badge variant="outline">{PROXY_STRATEGY_LABELS[selectedProxy.strategy]}</Badge>
                                        <span className="text-xs text-muted-foreground">
                                            {selectedProxy.enabledEndpointCount}/{selectedProxy.endpointCount} endpoint aktif
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {(Object.entries(selectedProxy.healthSummary) as Array<[string, number]>)
                                            .filter(([, count]) => count > 0)
                                            .map(([health, count]) => (
                                                <Badge key={health} variant="secondary">
                                                    {PROXY_HEALTH_LABELS[health.toUpperCase() as ProxyHealth] ?? health}: {count}
                                                </Badge>
                                            ))}
                                        {selectedProxy.endpointCount === 0 && (
                                            <span className="text-xs text-muted-foreground">Endpoint tanımlı değil</span>
                                        )}
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="oturum">
                    <Card>
                        <CardHeader>
                            <CardTitle>Oturum</CardTitle>
                            <CardDescription>
                                Çerez değerleri hiçbir zaman gösterilmez; yalnızca meta veriler listelenir.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <Field label="Çerez Profili" error={errors.cookieProfileId}>
                                <Select
                                    value={state.cookieProfileId === '' ? NONE : state.cookieProfileId}
                                    onValueChange={(v) => set('cookieProfileId', v === NONE ? '' : v)}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NONE}>Yok</SelectItem>
                                        {cookieProfiles.map((profile) => (
                                            <SelectItem key={profile.id} value={profile.id}>
                                                {profile.name} ({profile.cookieCount} çerez)
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            {selectedCookie !== undefined && (
                                <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium">{selectedCookie.name}</span>
                                        <Badge variant={COOKIE_VALIDATION_TONES[selectedCookie.validationStatus]}>
                                            {COOKIE_VALIDATION_LABELS[selectedCookie.validationStatus]}
                                        </Badge>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {selectedCookie.cookieCount} çerez · {selectedCookie.domainSummary} ·{' '}
                                        {selectedCookie.expirySummary}
                                    </div>
                                </div>
                            )}
                            <Field label="Oturum Politikası" error={errors.sessionPolicyId}>
                                <Select
                                    value={state.sessionPolicyId === '' ? NONE : state.sessionPolicyId}
                                    onValueChange={(v) => set('sessionPolicyId', v === NONE ? '' : v)}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NONE}>Yok (worker varsayılanı)</SelectItem>
                                        {sessionPolicies.map((policy) => (
                                            <SelectItem key={policy.id} value={policy.id}>
                                                {policy.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            {selectedPolicy !== undefined && (
                                <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                                    Havuz {selectedPolicy.poolSize} · maks. kullanım {selectedPolicy.maxUsageCount} · maks. yaş{' '}
                                    {selectedPolicy.maxAgeMinutes} dk · hata eşiği {selectedPolicy.failureThreshold}
                                </div>
                            )}
                            <SwitchField
                                id="sf-hitl"
                                label="İnsan müdahalesine izin"
                                description="Challenge görülürse run duraklar; siz kendi tarayıcınızda çözersiniz (asla otomatik çözüm yok)"
                                checked={state.humanInTheLoop}
                                onCheckedChange={(v) => set('humanInTheLoop', v)}
                            />
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="zamanlama">
                    <Card>
                        <CardHeader>
                            <CardTitle>Zamanlama</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <SwitchField
                                id="sf-enabled"
                                label="Tarama aktif"
                                description="Pasif taramalar zamanlanmaz ve çalıştırılamaz"
                                checked={state.enabled}
                                onCheckedChange={(v) => set('enabled', v)}
                            />
                            <div className="grid gap-4 md:grid-cols-2">
                                <Field
                                    label="Cron İfadesi"
                                    htmlFor="sf-schedule"
                                    error={errors.schedule}
                                    hint="Boş = yalnızca manuel çalıştırma"
                                >
                                    <Input
                                        id="sf-schedule"
                                        value={state.schedule}
                                        onChange={(e) => set('schedule', e.target.value)}
                                        placeholder="0 9 * * *"
                                        className="font-mono"
                                        aria-invalid={errors.schedule !== undefined}
                                    />
                                    {state.schedule.trim() !== '' && (
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {cronDescription !== null
                                                ? `→ ${cronDescription}`
                                                : '→ Özel ifade (olduğu gibi kullanılacak)'}
                                        </p>
                                    )}
                                </Field>
                                <Field label="Saat Dilimi" error={errors.timezone}>
                                    <Select value={state.timezone} onValueChange={(v) => set('timezone', v)}>
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {timezoneOptions.map((tz) => (
                                                <SelectItem key={tz} value={tz}>
                                                    {tz}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </Field>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="tanilama">
                    <Card>
                        <CardHeader>
                            <CardTitle>Tanılama</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <SwitchField
                                id="sf-debugMode"
                                label="Hata ayıklama modu"
                                description="Anomalilerde HTML + ekran görüntüsü arşivlenir"
                                checked={state.debugMode}
                                onCheckedChange={(v) => set('debugMode', v)}
                            />
                            <SwitchField
                                id="sf-storeRawHtml"
                                label="Ham HTML sakla"
                                description="İşlenen her sayfanın HTML'i saklanır (disk kullanımına dikkat)"
                                checked={state.storeRawHtml}
                                onCheckedChange={(v) => set('storeRawHtml', v)}
                            />
                            <SwitchField
                                id="sf-screenshots"
                                label="Hata durumunda ekran görüntüsü"
                                checked={state.storeScreenshotsOnFailure}
                                onCheckedChange={(v) => set('storeScreenshotsOnFailure', v)}
                            />
                            <SwitchField
                                id="sf-staleDetection"
                                label="Stale tespiti"
                                description="Ardışık başarılı run'larda görülmeyen ilanlar 'Güncel Değil' olur"
                                checked={state.staleDetectionEnabled}
                                onCheckedChange={(v) => set('staleDetectionEnabled', v)}
                            />
                            {state.staleDetectionEnabled && (
                                <Field
                                    label="Stale Eşiği (başarılı run sayısı, 1–20)"
                                    htmlFor="sf-staleAfter"
                                    error={errors.staleAfterSuccessfulRuns}
                                    className="max-w-xs"
                                >
                                    <Input
                                        id="sf-staleAfter"
                                        type="number"
                                        min={1}
                                        max={20}
                                        value={state.staleAfterSuccessfulRuns}
                                        onChange={(e) => set('staleAfterSuccessfulRuns', e.target.value)}
                                        aria-invalid={errors.staleAfterSuccessfulRuns !== undefined}
                                    />
                                </Field>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* Sticky action bar */}
            <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 backdrop-blur lg:left-56">
                <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-end gap-2 px-6 py-3">
                    {mode === 'edit' && (
                        <>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void duplicate()}
                                disabled={pending !== null}
                            >
                                <Copy />
                                Çoğalt
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void toggleEnabled()}
                                disabled={pending !== null}
                            >
                                {state.enabled ? 'Devre Dışı Bırak' : 'Aktifleştir'}
                            </Button>
                            <div className="mx-1 h-6 w-px bg-border" />
                        </>
                    )}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void runAction('test')}
                        disabled={pending !== null}
                    >
                        <FlaskConical />
                        Kaydet ve Test Et
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void runAction('run')}
                        disabled={pending !== null}
                    >
                        <Play />
                        Şimdi Çalıştır
                    </Button>
                    <Button size="sm" onClick={() => void runAction('save')} disabled={pending !== null}>
                        <Save />
                        {pending === 'save' ? 'Kaydediliyor…' : 'Kaydet'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
