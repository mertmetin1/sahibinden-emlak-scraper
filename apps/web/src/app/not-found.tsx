import { SearchX } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';

export default function NotFound() {
    return (
        <EmptyState
            icon={SearchX}
            title="Kayıt bulunamadı"
            description="Aradığınız kayıt silinmiş veya bağlantı hatalı olabilir."
            action={
                <Button asChild variant="outline" size="sm">
                    <Link href="/">Dashboard'a Dön</Link>
                </Button>
            }
        />
    );
}
