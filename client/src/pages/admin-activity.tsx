import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDateTime } from "@/lib/format";

interface Row { id: string; action: string; targetType: string | null; createdAt: string; actor: { name: string; role: string } | null }

// Who did what and when. Never shows what a record contained.
export default function AdminActivity() {
  const { t } = useI18n();
  const query = useQuery<Row[]>({ queryKey: ["/api/admin/audit?limit=100"] });
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t("admin.activity.title")} description={t("admin.activity.intro")} />
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
