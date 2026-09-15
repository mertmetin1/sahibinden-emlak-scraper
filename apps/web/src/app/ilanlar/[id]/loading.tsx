import { Skeleton } from '@/components/ui/skeleton';

export default function ListingDetailLoading() {
    return (
        <div className="space-y-4">
            <Skeleton className="h-9 w-2/3" />
            <div className="grid gap-4 xl:grid-cols-3">
                <div className="space-y-4 xl:col-span-2">
                    <Skeleton className="h-20" />
                    <Skeleton className="h-64" />
                    <Skeleton className="h-48" />
                </div>
                <div className="space-y-4">
                    <Skeleton className="h-40" />
                    <Skeleton className="h-56" />
                </div>
            </div>
        </div>
    );
}
