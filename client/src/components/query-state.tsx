import type { UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NetworkError } from "@/lib/queryClient";
import { useAppConfig } from "@/hooks/use-app-config";

export function LoadingBlock({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-3">
      <span className="sr-only">{label}…</span>
      <div className="h-6 w-1/3 animate-pulse rounded bg-secondary" />
      <div className="h-24 animate-pulse rounded-xl bg-secondary" />
      <div className="h-24 animate-pulse rounded-xl bg-secondary" />
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const config = useAppConfig();
  const offline = error instanceof NetworkError;
  const Icon = offline ? WifiOff : AlertTriangle;
  const message = error instanceof Error && error.message ? error.message : "Something went wrong.";
  return (
    <div role="alert" className="flex items-start gap-4 rounded-xl border-2 border-input bg-card p-5">
      <Icon className="mt-1 h-6 w-6 shrink-0 text-destructive" aria-hidden="true" />
      <div className="space-y-3">
        <div>
          <p className="font-semibold">{offline ? "No connection" : "We couldn't load this"}</p>
          <p className="text-muted-foreground">{message}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {onRetry && (
            <Button onClick={onRetry}>
              <RefreshCw aria-hidden="true" /> Try again
            </Button>
          )}
          {config?.support.phone && (
            <Button asChild variant="outline">
              <a href={`tel:${config.support.phone.replace(/[^\d+]/g, "")}`}>Call support: {config.support.phone}</a>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmptyBlock({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-input p-6 text-center">
      <p className="text-lg font-semibold">{title}</p>
      {children && <div className="mt-1 text-muted-foreground">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * One consistent way to show the four states every screen has: loading,
 * failed (with a retry), empty, and loaded. Pages pass the query and render
 * children only for real data.
 */
export default function QueryState<T>({
  query,
  isEmpty,
  empty,
  loadingLabel,
  children,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  empty?: React.ReactNode;
  loadingLabel?: string;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isLoading) return <LoadingBlock label={loadingLabel} />;
  if (query.isError) return <ErrorBlock error={query.error} onRetry={() => query.refetch()} />;
  if (query.data === undefined || query.data === null) return <LoadingBlock label={loadingLabel} />;
  if (isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
