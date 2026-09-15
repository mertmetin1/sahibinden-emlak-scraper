'use client';

import { X } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

/**
 * Chips input for string lists (allowedDomains). Enter, comma or blur adds
 * the pending value; Backspace on an empty input removes the last chip.
 */
export function ChipsInput({
    values,
    onChange,
    placeholder,
    id,
}: {
    values: string[];
    onChange: (values: string[]) => void;
    placeholder?: string;
    id?: string;
}) {
    const [pending, setPending] = useState('');

    const add = (raw: string) => {
        const value = raw.trim().replace(/,+$/, '');
        if (value === '') return;
        if (!values.includes(value)) onChange([...values, value]);
        setPending('');
    };

    return (
        <div className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-ring">
            {values.map((value) => (
                <Badge key={value} variant="secondary" className="gap-0.5">
                    {value}
                    <button
                        type="button"
                        onClick={() => onChange(values.filter((v) => v !== value))}
                        className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                        aria-label={`${value} kaldır`}
                    >
                        <X className="size-3" />
                    </button>
                </Badge>
            ))}
            <Input
                id={id}
                value={pending}
                onChange={(e) => {
                    const v = e.target.value;
                    if (v.includes(',')) {
                        add(v);
                    } else {
                        setPending(v);
                    }
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Tab') {
                        if (pending.trim() !== '') {
                            e.preventDefault();
                            add(pending);
                        }
                    } else if (e.key === 'Backspace' && pending === '' && values.length > 0) {
                        onChange(values.slice(0, -1));
                    }
                }}
                onBlur={() => add(pending)}
                placeholder={values.length === 0 ? placeholder : undefined}
                className="h-6 min-w-[140px] flex-1 border-0 bg-transparent px-1 py-0 shadow-none focus-visible:ring-0"
            />
        </div>
    );
}
