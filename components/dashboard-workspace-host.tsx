"use client";

import { usePathname } from "next/navigation";
import { MainWorkspace } from "@/components/main-workspace";
import { SubtitleWorkspace } from "@/components/subtitle-workspace";
import { cn } from "@/lib/utils";

export function DashboardWorkspaceHost({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const isSettings = pathname === "/settings";

  if (isSettings) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    );
  }

  const isTranscribe = pathname === "/" || pathname === "";
  const isSubtitle = pathname === "/subtitle";

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          isTranscribe ? "flex" : "hidden",
        )}
        aria-hidden={!isTranscribe}
        inert={!isTranscribe ? true : undefined}
      >
        <MainWorkspace isActive={isTranscribe} />
      </div>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          isSubtitle ? "flex" : "hidden",
        )}
        aria-hidden={!isSubtitle}
        inert={!isSubtitle ? true : undefined}
      >
        <SubtitleWorkspace isActive={isSubtitle} />
      </div>
    </div>
  );
}
