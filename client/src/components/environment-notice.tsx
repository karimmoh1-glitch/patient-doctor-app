import { TriangleAlert } from "lucide-react";
import { useAppConfig } from "@/hooks/use-app-config";

/** Shown on every screen of a test deployment (the host sets ENVIRONMENT_NOTICE); nothing is rendered otherwise. */
export function EnvironmentNotice() {
  const notice = useAppConfig()?.environmentNotice;
  if (!notice) return null;
  return (
    <div role="note" className="flex items-center justify-center gap-2 bg-amber-100 px-3 py-2 text-center text-sm font-semibold text-amber-950">
      <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      <span>{notice}</span>
    </div>
  );
}
