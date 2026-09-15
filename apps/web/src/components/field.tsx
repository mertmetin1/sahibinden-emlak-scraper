import type * as React from 'react';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * Form field wrapper: label + control + inline error / hint. `htmlFor` links
 * the label to the control; errors come from client validation or API 400
 * issue mapping.
 */
export function Field({
    label,
    htmlFor,
    error,
    hint,
    required = false,
    className,
    children,
}: {
    label: string;
    htmlFor?: string;
    error?: string | undefined;
    hint?: string;
    required?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={cn('flex flex-col gap-1.5', className)}>
            <Label htmlFor={htmlFor}>
                {label}
                {required && <span className="ml-0.5 text-destructive">*</span>}
            </Label>
            {children}
            {error !== undefined && error !== '' ? (
                <p className="text-xs text-destructive">{error}</p>
            ) : hint !== undefined && hint !== '' ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}

/** Switch row: label + description on the left, switch on the right. */
export function SwitchField({
    label,
    description,
    checked,
    onCheckedChange,
    disabled = false,
    id,
}: {
    label: string;
    description?: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    id?: string;
}) {
    return (
        <div className="flex items-center justify-between gap-4 rounded-md border bg-card px-3 py-2.5">
            <div className="min-w-0">
                <Label htmlFor={id} className="text-sm">
                    {label}
                </Label>
                {description !== undefined && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                )}
            </div>
            <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
        </div>
    );
}
