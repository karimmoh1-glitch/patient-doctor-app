import { useQuery, useQueryClient } from "@tanstack/react-query";
import QueryState from "@/components/query-state";
import { Switch } from "@/components/ui/switch";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";

interface Row { pairingId: string; doctorName: string; organizationName: string; staffCanSee: boolean }

/** Which clinics' staff can see this patient's name and appointment times, with a switch for each doctor. Nothing is hidden from the patient about it. */
export default function OrgVisibility() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery<Row[]>({ queryKey: ["/api/my-organizations"], staleTime: 0 });
  async function set(r: Row, visible: boolean) {
    try {
      await apiRequest("PUT", `/api/my-organizations/${r.pairingId}`, { visible });
      queryClient.invalidateQueries({ queryKey: ["/api/my-organizations"] });
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
    }
  }
  return (
    <section aria-labelledby="org-vis" className="space-y-3">
      <h2 id="org-vis" className="text-2xl font-semibold">{t("org.me.title")}</h2>
      <p className="text-lg text-muted-foreground">{t("org.me.intro")}</p>
      <QueryState query={query} loadingLabel={t("hp.loading")} isEmpty={(d) => d.length === 0} empty={<p className="text-lg">{t("org.me.none")}</p>}>
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={`${r.pairingId}-${r.organizationName}`} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-input bg-card p-4">
                <span>
                  <span className="block text-lg font-semibold">{t("org.me.row", { doctor: r.doctorName, org: r.organizationName })}</span>
                  <span className="block text-base text-muted-foreground">{r.staffCanSee ? t("org.me.on") : t("org.me.off")}</span>
                </span>
                <Switch checked={r.staffCanSee} onCheckedChange={(v) => set(r, v)} aria-label={t("org.me.row", { doctor: r.doctorName, org: r.organizationName })} />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
