import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Row { id: string; action: string; targetType: string | null; createdAt: string; actor: { name: string; role: string } | null }

interface Health {
  status: "active" | "stale" | "failing" | "not_configured";
  job: { lastSuccessAt: string | null; minutesSinceSuccess: number | null; lastError: string | null; consecutiveFailures: number };
  last24h: { scheduled: number; delivered: number; emailAccepted: number; emailFailed: number; emailGaveUp: number; stuckPending: number; overdue: number };
  nextHour: number;
}

// Whether reminders are really going out. Counts and times only.
function ReminderHealth() {
  const { t } = useI18n();
  const query = useQuery<Health>({ queryKey: ["/api/admin/reminders/status"], staleTime: 0, refetchInterval: 60_000 });
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="font-display text-2xl">{t("admin.rem.title")}</CardTitle>
        <p className="text-base text-muted-foreground">{t("admin.rem.intro")}</p>
      </CardHeader>
      <CardContent>
        <QueryState query={query} loadingLabel={t("admin.loading")}>
          {(h) => {
            const good = h.status === "active";
            const rows: [MessageKey, number][] = [
              ["admin.rem.scheduled", h.last24h.scheduled], ["admin.rem.delivered", h.last24h.delivered], ["admin.rem.emailAccepted", h.last24h.emailAccepted],
              ["admin.rem.emailFailed", h.last24h.emailFailed], ["admin.rem.emailGaveUp", h.last24h.emailGaveUp], ["admin.rem.stuck", h.last24h.stuckPending],
              ["admin.rem.overdue", h.last24h.overdue], ["admin.rem.nextHour", h.nextHour],
            ];
            return (
              <div className="space-y-4">
                <p role="status" className={`rounded-xl border-2 p-4 text-lg font-medium ${good ? "border-primary/40 bg-secondary" : "border-ochre bg-sand text-sand-foreground"}`}>
                  {t(`admin.rem.status.${h.status}` as MessageKey)}
                </p>
                <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                  <div><dt className="text-base font-semibold text-muted-foreground">{t("admin.rem.lastSuccess")}</dt>
                    <dd className="text-lg">{h.job.lastSuccessAt ? `${formatDateTime(h.job.lastSuccessAt)} (${t("admin.rem.minutesAgo", { count: h.job.minutesSinceSuccess ?? 0 })})` : t("admin.rem.never")}</dd></div>
                  <div><dt className="text-base font-semibold text-muted-foreground">{t("admin.rem.failures")}</dt><dd className="text-lg">{h.job.consecutiveFailures}</dd></div>
                  {rows.map(([k, v]) => (
                    <div key={k}><dt className="text-base font-semibold text-muted-foreground">{t(k)}</dt><dd className="text-lg">{v}</dd></div>
                  ))}
                </dl>
              </div>
            );
          }}
        </QueryState>
      </CardContent>
    </Card>
  );
}

// Who did what and when. Never shows what a record contained.
export default function AdminActivity() {
  const { t } = useI18n();
  const query = useQuery<Row[]>({ queryKey: ["/api/admin/audit?limit=100"] });
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t("admin.activity.title")} description={t("admin.activity.intro")} />
      <ReminderHealth />
      <QueryState query={query} loadingLabel={t("admin.loading")} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title={t("admin.activity.empty")} />}>
        {(rows) => (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card shadow-soft">
            {rows.map((r) => {
              const key = `admin.action.${r.action}` as MessageKey;
              const label = t(key);
              return (
                <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 p-4">
                  <span className="text-base font-medium">{label === key ? r.action : label}</span>
                  <span className="text-base text-muted-foreground">{r.actor ? `${r.actor.name} (${r.actor.role})` : t("admin.activity.system")} · {formatDateTime(r.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
