'use client';

import { Bell, BellOff, BellRing } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ensureNotificationPermission, notificationPermission } from '@/lib/human-solve-alert';

/**
 * One-click OS notification permission. Needed so a human-solve ping can
 * leave the tab; beep/toast still work without it.
 *
 * Permission is read after mount so SSR HTML matches the first client paint
 * (Notification is undefined on the server).
 */
export function NotificationEnable() {
    const [perm, setPerm] = useState<NotificationPermission | 'unsupported' | null>(null);

    useEffect(() => {
        setPerm(notificationPermission());
    }, []);

    const onClick = useCallback(async () => {
        const next = await ensureNotificationPermission();
        setPerm(next);
    }, []);

    if (perm === null || perm === 'unsupported') {
        return <span className="inline-block h-8 w-[9.5rem]" aria-hidden />;
    }

    if (perm === 'granted') {
        return (
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex" title="Doğrulama uyarıları açık">
                <BellRing className="size-3.5" />
                Uyarı açık
            </span>
        );
    }

    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onClick()}
            title={
                perm === 'denied'
                    ? 'Tarayıcı bildirimleri kapalı — tarayıcı ayarından açın'
                    : 'Doğrulama çıkınca masaüstü bildirimi göster'
            }
        >
            {perm === 'denied' ? <BellOff /> : <Bell />}
            {perm === 'denied' ? 'Bildirim kapalı' : 'Uyarıları aç'}
        </Button>
    );
}
