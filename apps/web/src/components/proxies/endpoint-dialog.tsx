'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Field } from '@/components/field';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPost } from '@/lib/api';

/** Add-endpoint dialog. Credentials are write-only (encrypted API-side). */
export function EndpointDialog({
    open,
    onOpenChange,
    profileId,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    profileId: string;
}) {
    const router = useRouter();
    const [host, setHost] = useState('');
    const [port, setPort] = useState('');
    const [protocol, setProtocol] = useState('http');
    const [name, setName] = useState('');
    const [country, setCountry] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [notes, setNotes] = useState('');
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [pending, setPending] = useState(false);

    const submit = async () => {
        const nextErrors: Record<string, string> = {};
        if (host.trim() === '') nextErrors.host = 'Host zorunludur';
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) nextErrors.port = '1–65535 arasında olmalı';
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;

        setPending(true);
        try {
            await apiPost(`/api/proxy-profiles/${profileId}/endpoints`, {
                host: host.trim(),
                port: portNum,
                protocol,
                ...(name.trim() !== '' ? { name: name.trim() } : {}),
                ...(country.trim() !== '' ? { country: country.trim() } : {}),
                ...(username !== '' ? { username } : {}),
                ...(password !== '' ? { password } : {}),
                ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
            });
            toast.success('Endpoint eklendi', { description: `${host.trim()}:${portNum}` });
            onOpenChange(false);
            router.refresh();
        } catch (err) {
            toast.error('Endpoint eklenemedi', {
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
                    <DialogTitle>Endpoint Ekle</DialogTitle>
                    <DialogDescription>
                        Kullanıcı adı/parola yalnızca yazılır — şifrelenerek saklanır ve bir daha asla gösterilmez.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Host" htmlFor="ep-host" required error={errors.host} className="col-span-2">
                        <Input id="ep-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="proxy.example.com" />
                    </Field>
                    <Field label="Port" htmlFor="ep-port" required error={errors.port}>
                        <Input id="ep-port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
                    </Field>
                    <Field label="Protokol">
                        <Select value={protocol} onValueChange={setProtocol}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="http">http</SelectItem>
                                <SelectItem value="https">https</SelectItem>
                                <SelectItem value="socks4">socks4</SelectItem>
                                <SelectItem value="socks5">socks5</SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field label="Etiket" htmlFor="ep-name">
                        <Input id="ep-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Opsiyonel" />
                    </Field>
                    <Field label="Ülke" htmlFor="ep-country">
                        <Input id="ep-country" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="TR" />
                    </Field>
                    <Field label="Kullanıcı Adı" htmlFor="ep-username">
                        <Input id="ep-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                    </Field>
                    <Field label="Parola" htmlFor="ep-password">
                        <Input
                            id="ep-password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="new-password"
                        />
                    </Field>
                    <Field label="Notlar" htmlFor="ep-notes" className="col-span-2">
                        <Textarea id="ep-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
                    </Field>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        Vazgeç
                    </Button>
                    <Button onClick={() => void submit()} disabled={pending}>
                        {pending ? 'Ekleniyor…' : 'Ekle'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
