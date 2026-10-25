import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatRelativeDay, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Item { id: string; kind: string; params: Record<string, string | number>; link: string | null; createdAt: string; read: boolean }

// Wording is chosen here, in the reader's language, from a kind and a few
// parameters: the server never stores sentence text, and a reminder only
// names the medicine if the patient chose that.
function messageFor(t: (k: MessageKey, v?: Record<string, string | number>) => string, n: Item): string {
  if (n.kind === "reminder.due") {
    return n.params.medicationName ? t("notif.reminder.dueNamed", n.params) : t("notif.reminder.due", n.params);
  }
  const key = `notif.${n.kind}` as MessageKey;
  // A time arrives as an instant and is shown in the reader's language and zone.
  const params = n.params.when ? { ...n.params, when: formatRelativeDay(String(n.params.when)) } : n.params;
  const text = t(key, params);
  return text === key ? t("notif.generic") : text;
}

export default function Notifications() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery<{ unread: number; items: Item[] }>({ queryKey: ["/api/notifications"], staleTime: 0 });

  async function markAllRead() {
    await apiRequest("POST", "/api/notifications/read", {});
    queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
  }

  // Opening the page counts as seeing them, but only after they've been shown once.
  useEffect(() => () => {
    queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
  }, [queryClient]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t("top.notifications")}
        description={t("notif.intro")}
        actions={query.data && query.data.unread > 0 ? <Button variant="outline" onClick={markAllRead}><CheckCheck aria-hidden="true" /> {t("notif.markAll")}</Button> : undefined}
      />
      <QueryState query={query} isEmpty={(d) => d.items.length === 0} empty={<EmptyBlock title={t("notif.empty")}>{t("notif.emptyBody")}</EmptyBlock>}>
        {(data) => (
          <ul className="space-y-3">
            {data.items.map((n) => (
              <li key={n.id} className={cn("flex items-start gap-4 rounded-2xl border bg-card p-4 shadow-soft", n.read ? "border-border" : "border-primary/50")}>
                <span className={cn("mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", n.read ? "bg-muted text-muted-foreground" : "bg-secondary text-primary")}><Bell className="h-5 w-5" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-medium">{!n.read && <span className="me-2 rounded-full bg-primary px-2.5 py-0.5 text-sm font-bold text-primary-foreground">{t("notif.new")}</span>}{messageFor(t, n)}</p>
                  <p className="text-base text-muted-foreground">{timeAgo(n.createdAt)}</p>
                  {n.link && <Link href={n.link} className="mt-1 inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">{t("notif.open")}</Link>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
