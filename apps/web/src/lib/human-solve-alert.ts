/**
 * Operator ping when the crawler is waiting for a manual challenge solve.
 * Client-only. Does not talk to the worker.
 */

import { toast } from 'sonner';

const ALERTED_KEY = 'human-solve-alerted-ids';
const memoryAlerted = new Set<string>();

function readAlerted(): string[] {
    try {
        const raw = sessionStorage.getItem(ALERTED_KEY);
        if (raw === null) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

function markAlerted(eventId: string): void {
    memoryAlerted.add(eventId);
    try {
        const ids = readAlerted();
        if (ids.includes(eventId)) return;
        ids.push(eventId);
        sessionStorage.setItem(ALERTED_KEY, JSON.stringify(ids.slice(-80)));
    } catch {
        // private mode — in-memory toast/notification still fire once this tab
    }
}

function alreadyAlerted(eventId: string): boolean {
    if (memoryAlerted.has(eventId)) return true;
    return readAlerted().includes(eventId);
}

function playBeep(): void {
    try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx === undefined) return;
        const ctx = new Ctx();
        const beep = (at: number, freq: number) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(at);
            osc.stop(at + 0.24);
        };
        void ctx.resume().then(() => {
            const t = ctx.currentTime;
            beep(t, 880);
            beep(t + 0.28, 1174);
            beep(t + 0.56, 880);
        });
    } catch {
        // autoplay policy — toast + Notification still carry the alert
    }
}

export async function ensureNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
        return Notification.permission;
    }
    try {
        return await Notification.requestPermission();
    } catch {
        return Notification.permission;
    }
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
}

export function alertHumanSolve(opts: {
    runId: string;
    eventId: string;
    kind?: string | null;
    url?: string | null;
}): void {
    if (alreadyAlerted(opts.eventId)) return;
    markAlerted(opts.eventId);

    const kind = opts.kind && opts.kind.length > 0 ? opts.kind : 'doğrulama';
    const where = opts.url && opts.url.length > 0 ? `\n${opts.url}` : '';
    const body = `Debug Chrome’da ${kind} ekranını geçin.${where}`;

    playBeep();
    toast.warning('İnsan doğrulaması bekleniyor', {
        description: body,
        duration: 25_000,
        action: {
            label: 'Run’a git',
            onClick: () => {
                window.location.href = `/calistirmalar/${opts.runId}`;
            },
        },
    });

    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
        const note = new Notification('SahibindenBot — doğrulama bekleniyor', {
            body,
            tag: `human-solve-${opts.eventId}`,
            requireInteraction: true,
        });
        note.onclick = () => {
            window.focus();
            window.location.href = `/calistirmalar/${opts.runId}`;
            note.close();
        };
    } catch {
        // Notification constructor can throw if the OS blocks toasts
    }
}

export function payloadKindUrl(data: unknown): { kind: string | null; url: string | null; resumeUrl: string | null } {
    if (typeof data !== 'object' || data === null) return { kind: null, url: null, resumeUrl: null };
    const rec = data as Record<string, unknown>;
    return {
        kind: typeof rec.kind === 'string' ? rec.kind : null,
        url: typeof rec.url === 'string' ? rec.url : null,
        resumeUrl: typeof rec.resumeUrl === 'string' ? rec.resumeUrl : null,
    };
}

export function alertUnusualAccess(opts: {
    runId: string;
    eventId: string;
    resumeUrl?: string | null;
}): void {
    if (alreadyAlerted(opts.eventId)) return;
    markAlerted(opts.eventId);

    const where = opts.resumeUrl && opts.resumeUrl.length > 0 ? opts.resumeUrl : 'kaldığın sayfa';
    const body = `10 dakika bekleniyor, çerezler temizlenip şuradan devam:\n${where}`;

    playBeep();
    toast.warning('Olağan dışı erişim — 10 dk mola', {
        description: body,
        duration: 25_000,
        action: {
            label: 'Run’a git',
            onClick: () => {
                window.location.href = `/calistirmalar/${opts.runId}`;
            },
        },
    });

    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
        const note = new Notification('SahibindenBot — olağan dışı erişim', {
            body,
            tag: `unusual-access-${opts.eventId}`,
            requireInteraction: true,
        });
        note.onclick = () => {
            window.focus();
            window.location.href = `/calistirmalar/${opts.runId}`;
            note.close();
        };
    } catch {
        // Notification constructor can throw if the OS blocks toasts
    }
}
