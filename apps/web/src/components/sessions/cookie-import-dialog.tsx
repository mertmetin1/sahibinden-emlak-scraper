'use client';

import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPost } from '@/lib/api';
import type { CookieImportResultDto } from '@/lib/types';

/**
 * Cookie import (create) / replace dialog. cookieJson is WRITE-ONLY: the API
 * normalizes + encrypts it and never returns it. The UI never displays,
 * stores or re-reads cookie values.
 */
export function CookieImportDialog({
    open,
    onOpenChange,
    mode,
    profileId,
    profileName,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'import' | 'replace';
    /** replace mode only. */
    profileId?: string;
    profileName?: string;
}) {
    const router = useRouter();
    const [name, setName] = useState('');
    const [cookieJson, setCookieJson] = useState('');
    const [notes, setNotes] = useState('');
    const [issues, setIssues] = useState<string[]>([]);
    const [pending, setPending] = useState(false);

    const submit = async () => {
        if (cookieJson.trim() === '') return;
        setPending(true);
        setIssues([]);
        try {
            // cookieJson is sent as a string; the API accepts JSON text or a raw Cookie header.
            const result =
                mode === 'import'
                    ? await apiPost<CookieImportResultDto>('/api/cookie-profiles', {
                          name: name.trim(),
                          cookieJson: cookieJson.trim(),
                          ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
                      })
                    : await apiPost<CookieImportResultDto>(`/api/cookie-profiles/${profileId}/replace`, {
                          cookieJson: cookieJson.trim(),
                      });
            setIssues(result.issues);
            if (result.issues.length === 0) {
                toast.success(mode === 'import' ? 'Çerez profili içe aktarıldı' : 'Çerezler değiştirildi', {
                    description: `${result.profile.cookieCount} çerez`,
                });
                onOpenChange(false);
            } else {
                toast.warning(`İçe aktarıldı, ${result.issues.length} uyarı var`);
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
                    <DialogTitle>
                        {mode === 'import' ? 'Çerez Profili İçe Aktar' : `Çerezleri Değiştir — ${profileName ?? ''}`}
                    </DialogTitle>
                </DialogHeader>

                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <p>
                        Çerez değerleri <strong>yalnızca yazılır</strong>: şifrelenerek saklanır ve bir daha hiçbir
                        API yanıtında gösterilmez. Bu alana yapıştırdığınız içerik panelde asla listelenmez.
                    </p>
                </div>

                <div className="space-y-4">
                    {mode === 'import' && (
                        <>
                            <Field label="Profil Adı" htmlFor="ci-name" required>
                                <Input
                                    id="ci-name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="ör. Ana Hesap Çerezleri"
                                />
                            </Field>
                            <Field label="Notlar" htmlFor="ci-notes">
                                <Input
                                    id="ci-notes"
                                    value={notes}
                                    onChange={(e) => setNotes(e.target.value)}
                                    placeholder="Opsiyonel"
                                />
                            </Field>
                        </>
                    )}
                    <Field
                        label="Çerez JSON / Header"
                        htmlFor="ci-json"
                        required
                        hint="EditThisCookie / Cookie-Editor JSON dizisi, { cookies: [...] } veya ham Cookie header"
                    >
                        <Textarea
                            id="ci-json"
                            value={cookieJson}
                            onChange={(e) => setCookieJson(e.target.value)}
                            rows={8}
                            className="font-mono text-xs"
                            placeholder='[{"name": "...", "value": "...", "domain": ".sahibinden.com"}]'
                        />
                    </Field>
                    {issues.length > 0 && (
                        <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-3 text-xs">
                            {issues.map((issue, index) => (
                                <li key={index} className="text-warning">
                                    {issue}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        Vazgeç
                    </Button>
                    <Button
                        onClick={() => void submit()}
                        disabled={pending || cookieJson.trim() === '' || (mode === 'import' && name.trim() === '')}
                    >
                        {pending ? 'İşleniyor…' : mode === 'import' ? 'İçe Aktar' : 'Değiştir'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
