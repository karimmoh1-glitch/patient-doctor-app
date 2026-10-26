import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Clock, ShieldOff, XCircle, TimerOff } from "lucide-react";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Ltr } from "@/components/ltr";
import { ReasonDialog } from "@/components/reason-dialog";
import { VerificationDialog } from "@/components/verification-dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate } from "@/lib/format";

type Status = "submitted" | "pending" | "verified" | "rejected" | "suspended" | "expired";
interface Credential {
  id: string; kind: "license" | "npi"; identifier: string; jurisdiction: string | null; issuer: string | null; status: Status; storedStatus: string;
  source: string | null; evidenceNote: string | null; reviewedAt: string | null; expiresAt: string | null; doctorName: string | null;
}
const FILTERS = ["all", "expiring", "expired", "open"] as const;
const ICON: Record<Status, typeof Clock> = { submitted: Clock, pending: Clock, verified: BadgeCheck, rejected: XCircle, suspended: ShieldOff, expired: TimerOff };

export default function AdminCredentials() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const key = `/api/admin/credentials?filter=${filter}`;
  const query = useQuery<Credential[]>({ queryKey: [key], staleTime: 0 });
  async function act(id: string, action: string, body: unknown, done: MessageKey) {
    try {
      await apiRequest("POST", `/api/admin/credentials/${id}/${action}`, body);
      toast({ title: t(done) });
      queryClient.invalidateQueries({ queryKey: [key] });
    } catch (err: any) {
      toast({ title: t("admin.actionFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t("cred.title")} description={t("cred.intro")} />
      <div role="radiogroup" aria-label={t("cred.filter")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button key={f} role="radio" aria-checked={filter === f} variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>{t(`cred.filter.${f}` as MessageKey)}</Button>
        ))}
      </div>
      <QueryState query={query} loadingLabel={t("admin.loading")} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title={t("cred.empty")} />}>
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((c) => {
              const Icon = ICON[c.status];
              return (
                <li key={c.id} className="space-y-2 rounded-2xl border border-border bg-card p-4 shadow-soft">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="font-display text-xl">{c.doctorName ?? "—"}</h2>
                    <Badge variant={c.status === "verified" ? "default" : c.status === "pending" || c.status === "submitted" ? "secondary" : "destructive"} className="gap-1.5">
                      <Icon className="h-4 w-4" aria-hidden="true" />{t(`cred.status.${c.status}` as MessageKey)}
                    </Badge>
                  </div>
                  <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2 text-base">
                    <div><dt className="font-semibold text-muted-foreground">{t(`cred.kind.${c.kind}` as MessageKey)}</dt><dd><Ltr>{c.identifier}</Ltr>{c.jurisdiction ? ` · ${c.jurisdiction}` : ""}</dd></div>
                    <div><dt className="font-semibold text-muted-foreground">{t("cred.validUntil")}</dt><dd>{c.expiresAt ? formatDate(c.expiresAt) : "—"}</dd></div>
                    {c.source && <div><dt className="font-semibold text-muted-foreground">{t("admin.verify.source")}</dt><dd>{t(`admin.verify.source.${c.source}` as MessageKey)}</dd></div>}
                    {c.evidenceNote && <div><dt className="font-semibold text-muted-foreground">{t("admin.verify.note")}</dt><dd>{c.evidenceNote}</dd></div>}
                  </dl>
                  <div className="flex flex-wrap gap-3">
                    {c.status !== "rejected" && (
                      <VerificationDialog
                        trigger={<Button>{c.storedStatus === "verified" ? t("cred.renew") : t("cred.verify")}<span className="sr-only">: {c.doctorName}</span></Button>}
                        title={t("cred.verify.title", { name: c.doctorName ?? "" })} description={t("cred.verify.body")} confirmLabel={t("cred.verify.confirm")}
                        onSubmit={(v) => act(c.id, "verify", v, "cred.verified")}
                      />
                    )}
                    {c.storedStatus === "verified" && (
                      <ReasonDialog
                        trigger={<Button variant="outline">{t("cred.suspend")}<span className="sr-only">: {c.doctorName}</span></Button>}
                        title={t("cred.suspend.title")} description={t("cred.suspend.body")} label={t("admin.suspend.label")} confirm={t("cred.suspend.confirm")} required
                        onSubmit={(note) => act(c.id, "suspend", { note }, "cred.suspended")}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
