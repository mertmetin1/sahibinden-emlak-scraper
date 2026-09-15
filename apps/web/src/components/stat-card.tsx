import type { LucideIcon } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Dense dashboard stat card: label, big value, optional sub-line + icon. */
export function StatCard({
    label,
    value,
    sub,
    icon: Icon,
    tone = 'default',
}: {
    label: string;
    value: string;
    sub?: string;
    icon?: LucideIcon;
    tone?: 'default' | 'success' | 'warning' | 'destructive' | 'info';
}) {
    const toneClass =
        tone === 'success'
            ? 'text-success'
            : tone === 'warning'
              ? 'text-warning'
              : tone === 'destructive'
                ? 'text-destructive'
                : tone === 'info'
                  ? 'text-primary'
                  : 'text-foreground';
    return (
        <Card className="p-4">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
                {Icon !== undefined && <Icon className="size-4 text-muted-foreground/60" />}
            </div>
            <div className={cn('mt-1.5 text-2xl font-semibold tabular-nums', toneClass)}>{value}</div>
            {sub !== undefined && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
        </Card>
    );
}
