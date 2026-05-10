import { SidebarNav } from "@/components/sidebar-nav";
import { TranscribeEventBridge } from "@/components/transcribe-event-bridge";
import { DashboardWorkspaceHost } from "@/components/dashboard-workspace-host";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <TranscribeEventBridge />
      <SidebarNav />
      <DashboardWorkspaceHost>{children}</DashboardWorkspaceHost>
    </div>
  );
}
