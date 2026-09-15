'use client';

import {
    Activity,
    Cookie,
    LayoutDashboard,
    Radar,
    Rows3,
    Server,
    Settings,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

const NAV_ITEMS = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
    { href: '/ilanlar', label: 'İlanlar', icon: Rows3, exact: false },
    { href: '/taramalar', label: 'Taramalar', icon: Radar, exact: false },
    { href: '/calistirmalar', label: 'Çalıştırmalar', icon: Activity, exact: false },
    { href: '/proxyler', label: "Proxy'ler", icon: Server, exact: false },
    { href: '/oturumlar', label: 'Oturumlar', icon: Cookie, exact: false },
    { href: '/ayarlar', label: 'Ayarlar', icon: Settings, exact: false },
] as const;

export function Sidebar() {
    const pathname = usePathname();

    return (
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r bg-card lg:flex">
            <div className="flex h-14 items-center gap-2 border-b px-4">
                <Radar className="size-5 text-primary" />
                <div className="leading-tight">
                    <div className="text-sm font-semibold">SahibindenBot</div>
                    <div className="text-[11px] text-muted-foreground">Yönetim Paneli</div>
                </div>
            </div>
            <nav className="flex-1 space-y-0.5 p-2">
                {NAV_ITEMS.map((item) => {
                    const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                                active
                                    ? 'bg-primary/10 font-medium text-primary'
                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                            )}
                        >
                            <item.icon className="size-4" />
                            {item.label}
                        </Link>
                    );
                })}
            </nav>
            <div className="border-t p-3 text-[11px] text-muted-foreground">sahibinden.com yerel tarayıcı</div>
        </aside>
    );
}
