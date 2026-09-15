import { Skeleton } from '@/components/ui/skeleton';

export default function SettingsLoading() {
    return (
        <div className="space-y-4">
            <Skeleton className="h-8 w-32" />
            <div className="grid gap-4 xl:grid-cols-2">
                <Skeleton className="h-72" />
                <Skeleton className="h-72" />
            </div>
        </div>
    );
}
