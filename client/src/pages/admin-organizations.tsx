import { useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ReasonDialog } from "@/components/reason-dialog";
import { VerificationDialog } from "@/components/verification-dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate } from "@/lib/format";

interface Org { id: string; name: string; kind: string; country: string; contactEmail: string | null; status: "unverified" | "verified" | "suspended"; verifiedAt: string | null; verificationSource: string | null; verificationNote: string | null; createdAt: string }

export default function AdminOrganizations() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const q = useQuery<Org[]>({ queryKey: ["/api/admin/organizations"], staleTime: 0 });
  async function act(id: string, action: string, body?: unknown) {
    try {
      await apiRequest("POST", `/api/admin/organizations/${id}/${action}`, body);
      toast({ title: t("org.admin.verified") });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/organizations"] });
    } catch (err: any) {
      toast({ title: t("admin.actionFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t("org.admin.title")} description={t("org.admin.intro")} />
      <QueryState query={q} loadingLabel={t("admin.loading")} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title={t("org.none.title")} />}>
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((o) => (
              <li key={o.id} className="space-y-2 rounded-2xl border border-border bg-card p-4 shadow-soft">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-display text-xl">{o.name}</h2>
                  <Badge variant={o.status === "verified" ? "default" : o.status === "suspended" ? "destructive" : "secondary"}>{t(`org.status.${o.status}` as MessageKey)}</Badge>
                </div>
                <p className="text-base text-muted-foreground">{t(`org.kind.${o.kind}` as MessageKey)} · {t(`hp.country.${o.country}` as MessageKey)} · {formatDate(o.createdAt)}{o.contactEmail ? ` · ${o.contactEmail}` : ""}</p>
                {o.verificationSource && <p className="text-base">{t(`admin.verify.source.${o.verificationSource}` as MessageKey)}: {o.verificationNote}</p>}
                <div className="flex flex-wrap gap-3">
                  {o.status !== "suspended" && (
                    <VerificationDialog
                      withExpiry={false}
                      trigger={<Button>{t("org.admin.verify")}<span className="sr-only">: {o.name}</span></Button>}
                      title={t("org.admin.verify.title", { name: o.name })} description={t("org.admin.intro")} confirmLabel={t("cred.verify.confirm")}
                      onSubmit={(v) => act(o.id, "verify", { source: v.source, evidenceNote: v.evidenceNote })}
                    />
                  )}
                  {o.status !== "suspended" ? (
                    <ReasonDialog
                      trigger={<Button variant="outline">{t("org.admin.suspend")}<span className="sr-only">: {o.name}</span></Button>}
                      title={t("cred.suspend.title")} description={t("cred.suspend.body")} label={t("admin.suspend.label")} confirm={t("cred.suspend.confirm")} required
                      onSubmit={(note) => act(o.id, "suspend", { note })}
                    />
                  ) : (
                    <Button variant="outline" onClick={() => act(o.id, "unsuspend")}>{t("org.admin.unsuspend")}<span className="sr-only">: {o.name}</span></Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
