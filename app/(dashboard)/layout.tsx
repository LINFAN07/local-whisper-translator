import { SidebarNav } from "@/components/sidebar-nav";
import { TranscribeEventBridge } from "@/components/transcribe-event-bridge";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <TranscribeEventBridge />
      <SidebarNav />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
