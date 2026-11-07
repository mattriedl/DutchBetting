'use client';

import { useSession } from 'next-auth/react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function DashboardHeader({ onRefresh, loading }: { onRefresh?: () => void; loading?: boolean }) {
  const { data: session } = useSession() || {};

  return (
    <div className="flex items-center justify-between w-full">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-foreground">
          {session?.user?.name ?? session?.user?.email ?? 'User'}
        </span>
        <Badge variant="outline" className="text-[10px] font-mono">
          {(session?.user as any)?.role === 'admin' ? 'ADMIN' : 'USER'}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={loading}
            className="text-muted-foreground"
          >
            <RefreshCw className={cn('w-4 h-4', loading ? 'animate-spin' : '')} />
          </Button>
        )}
        <ThemeToggle />
      </div>
    </div>
  );
}

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ');
}
