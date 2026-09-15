import type { Metadata } from 'next';
import type * as React from 'react';

import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { Toaster } from '@/components/ui/sonner';

import './globals.css';

export const metadata: Metadata = {
    title: {
        default: 'SahibindenBot — Yönetim Paneli',
        template: '%s · SahibindenBot',
    },
    description: 'Yerel sahibinden.com tarayıcı yönetim paneli',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="tr">
            <body>
                <div className="flex min-h-screen">
                    <Sidebar />
                    <div className="flex min-w-0 flex-1 flex-col">
                        <Topbar />
                        <main className="mx-auto w-full max-w-[1400px] flex-1 p-6">{children}</main>
                    </div>
                </div>
                <Toaster />
            </body>
        </html>
    );
}
