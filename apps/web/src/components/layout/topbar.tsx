import { HealthIndicator } from '@/components/layout/health-indicator';
import { NotificationEnable } from '@/components/layout/notification-enable';

/** Top bar: health indicator on the right; pages render their own headers. */
export function Topbar() {
    return (
        <header className="sticky top-0 z-30 flex h-14 items-center justify-end gap-3 border-b bg-card/95 px-6 backdrop-blur">
            <NotificationEnable />
            <HealthIndicator />
        </header>
    );
}
