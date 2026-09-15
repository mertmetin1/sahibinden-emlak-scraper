import { Skeleton } from '@/components/ui/skeleton';

export default function ListingsLoading() {
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-9 w-48" />
            </div>
            <Skeleton className="h-[480px] w-full" />
        </div>
    );
}
