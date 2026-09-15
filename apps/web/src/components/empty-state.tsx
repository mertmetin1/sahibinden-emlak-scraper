import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';

import { Card } from '@/components/ui/card';

/** Empty state with a real next action (button/link passed by the caller). */
export function EmptyState({
    icon: Icon,
    title,
    description,
    action,
}: {
    icon: LucideIcon;
    title: string;
    description?: string;
    action?: React.ReactNode;
}) {
    return (
        <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                <Icon className="size-5 text-muted-foreground" />
            </div>
            <h2 className="text-sm font-semibold">{title}</h2>
            {description !== undefined && (
                <p className="max-w-md text-sm text-muted-foreground">{description}</p>
            )}
            {action !== undefined && <div className="mt-3">{action}</div>}
        </Card>
    );
}
