import { Skeleton } from '@/components/ui/skeleton';

export default function RunDetailLoading() {
    return (
        <div className="space-y-4">
            <Skeleton className="h-8 w-64" />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                {Array.from({ length: 10 }, (_, i) => (
                    <Skeleton key={i} className="h-16" />
                ))}
            </div>
            <Skeleton className="h-[480px] w-full" />
        </div>
    );
}
