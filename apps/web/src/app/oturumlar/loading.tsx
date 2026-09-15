import { Skeleton } from '@/components/ui/skeleton';

export default function SessionsLoading() {
    return (
        <div className="space-y-6">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-56 w-full" />
        </div>
    );
}
