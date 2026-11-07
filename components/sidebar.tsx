'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { cn } from '@/lib/utils';
import {
  BarChart3,
  LayoutDashboard,
  TrendingUp,
  Settings,
  LineChart,
  Target,
  LogOut,
  Thermometer,
  History,
  FlaskConical,
  Bot,
  Trophy,
  Goal,
  Globe,
  Percent,
  BrainCircuit,
  ListChecks,
  BadgeDollarSign,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const navItems = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Markets', href: '/markets', icon: Thermometer },
  { label: 'Opportunities', href: '/opportunities', icon: Target },
  { label: 'Analytics', href: '/analytics', icon: LineChart },
  { label: 'History', href: '/history', icon: History },
  { label: 'Auto-Bet', href: '/auto-bet', icon: Bot },
  { label: 'Soccer', href: '/soccer', icon: Trophy },
  { label: 'Correct Score', href: '/correct-score', icon: Goal },
  { label: 'Goals Markets', href: '/goals', icon: Percent },
  { label: 'Polymarket Score', href: '/polymarket-cs', icon: Globe },
  { label: 'AI Tracker', href: '/ai-tracker', icon: BrainCircuit },
  { label: 'Predictions', href: '/predictions', icon: ListChecks },
  { label: 'Value Tracker', href: '/value-tracker', icon: BadgeDollarSign },
  { label: 'Backtest', href: '/backtest', icon: FlaskConical },
  { label: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname() ?? '';

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center gap-3 px-2 py-3 mb-6">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-emerald-500 flex items-center justify-center shadow-lg shadow-blue-500/20">
          <BarChart3 className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="font-display text-sm font-bold tracking-tight text-foreground">Dutch Betting</h1>
          <p className="text-[10px] text-muted-foreground font-mono">KALSHI CLIMATE</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1">
        {(navItems ?? []).map((item: any) => {
          const Icon = item?.icon;
          const isActive = pathname === item?.href || pathname?.startsWith?.(`${item?.href}/`);
          return (
            <Link
              key={item?.href ?? ''}
              href={item?.href ?? '/dashboard'}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                isActive
                  ? 'bg-blue-600/15 text-blue-400 shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              {Icon && <Icon className={cn('w-4 h-4', isActive ? 'text-blue-400' : '')} />}
              {item?.label ?? ''}
              {isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400" />}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="pt-4 border-t border-border/50 mt-4">
        <div className="flex items-center gap-2 px-2 py-2 mb-2">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          <span className="text-xs text-muted-foreground">v1.0 • Live</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-destructive"
          onClick={() => signOut?.({ callbackUrl: '/login' })}
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sign Out
        </Button>
      </div>
    </div>
  );
}
