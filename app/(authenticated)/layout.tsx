import { AppShell } from '@/components/layouts/app-shell';
import { Sidebar } from '@/components/sidebar';
import { DashboardHeader } from '@/components/dashboard-header';

export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      sidebar={<Sidebar />}
      header={<DashboardHeader />}
    >
      {children}
    </AppShell>
  );
}
