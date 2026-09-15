'use client';

import { useRouter } from 'next/navigation';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { RUN_STATUS_LABELS } from '@/lib/labels';
import type { RunStatus } from '@/lib/types';

const ALL = '__all__';
const STATUSES: RunStatus[] = [
    'QUEUED',
    'STARTING',
    'RUNNING',
    'CANCELLING',
    'CANCELLED',
    'SUCCEEDED',
    'PARTIAL',
    'FAILED',
];

/** Runs filter bar — writes scanId/status into the URL (server refetches). */
export function RunFilters({
    scans,
    currentScanId,
    currentStatus,
}: {
    scans: Array<{ id: string; name: string }>;
    currentScanId: string;
    currentStatus: string;
}) {
    const router = useRouter();

    const push = (scanId: string, status: string) => {
        const params = new URLSearchParams();
        if (scanId !== '') params.set('scanId', scanId);
        if (status !== '') params.set('status', status);
        const qs = params.toString();
        router.push(qs === '' ? '/calistirmalar' : `/calistirmalar?${qs}`);
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="w-64">
                <Select
                    value={currentScanId === '' ? ALL : currentScanId}
                    onValueChange={(v) => push(v === ALL ? '' : v, currentStatus)}
                >
                    <SelectTrigger>
                        <SelectValue placeholder="Tarama" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL}>Tüm Taramalar</SelectItem>
                        {scans.map((scan) => (
                            <SelectItem key={scan.id} value={scan.id}>
                                {scan.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="w-48">
                <Select
                    value={currentStatus === '' ? ALL : currentStatus}
                    onValueChange={(v) => push(currentScanId, v === ALL ? '' : v)}
                >
                    <SelectTrigger>
                        <SelectValue placeholder="Durum" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL}>Tüm Durumlar</SelectItem>
                        {STATUSES.map((status) => (
                            <SelectItem key={status} value={status}>
                                {RUN_STATUS_LABELS[status]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
        </div>
    );
}
