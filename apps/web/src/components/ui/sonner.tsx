'use client';

import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** App-wide toast host (light theme — the panel is light-only). */
function Toaster(props: ToasterProps) {
    return (
        <Sonner
            theme="light"
            position="bottom-right"
            toastOptions={{
                classNames: {
                    toast: 'rounded-md border shadow-lg',
                },
            }}
            {...props}
        />
    );
}

export { Toaster };
