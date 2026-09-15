import { Skeleton } from '@/components/ui/skeleton';

export default function EditScanLoading() {
    return (
        <div className="space-y-4">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-9 w-[480px]" />
            <Skeleton className="h-72 w-full" />
        </div>
    );
}
