import type * as React from 'react';

import { cn } from '@/lib/utils';

/** Consistent page heading: title, optional description, right-aligned actions. */
export function PageHeader({
    title,
    description,
    actions,
    className,
}: {
    title: string;
    description?: string;
    actions?: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={cn('mb-4 flex flex-wrap items-start justify-between gap-3', className)}>
            <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                {description !== undefined && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
            </div>
            {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
    );
}
