import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { RefreshCw, Pill, Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/status-badge";
import ExplainSimplyButton from "@/components/explain-simply-button";
import ConfirmAction from "@/components/confirm-action";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAppConfig } from "@/hooks/use-app-config";
import { formatDate } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { specialtyLabel } from "@/lib/labels";

interface Prescription {
  id: string;
  medicationName: string;
  instructions: string;
  strength: string | null;
  formulation: string | null;
  dose: string | null;
  route: string | null;
  warnings: string | null;
  frequencyPerDay: number;
  refillsAllowed: number;
  refillsUsed: number;
  status: string;
  startDate: string;
  endDate: string | null;
  authorizedAt: string | null;
  transmission: string;
  doctor: { name: string; specialty: string } | null;
  tracked: boolean;
}

// A prescription here is a record the doctor wrote and authorized inside
// Avela. It says, every time, that it has not been sent to a pharmacy: that
// only becomes true when a real pharmacy connection confirms it.
export default function Prescriptions() {
  const { t } = useI18n();
  const { toast } = useToast();
  const config = useAppConfig();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const query = useQuery<Prescription[]>({ queryKey: ["/api/prescriptions"] });

  async function track(id: string) {
    setBusyId(id);
    try {
      await apiRequest("POST", `/api/prescriptions/${id}/track`);
      queryClient.invalidateQueries({ queryKey: ["/api/prescriptions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/medications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/medications/today"] });
      toast({ title: t("rx.added") });
    } catch (err: any) {
      toast({ title: t("rx.addFailed"), description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function askForRefill(p: Prescription) {
    try {
      const res = await apiRequest("POST", `/api/prescriptions/${p.id}/refill`);
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/prescriptions"] });
      toast({
        title: data.notifiedDoctor ? t("rx.refill.sent", { name: p.doctor?.name ?? "" }) : t("rx.refill.saved"),
        description: data.notifiedDoctor ? t("rx.refill.sentBody") : t("rx.refill.savedBody"),
      });
    } catch (err: any) {
      toast({ title: t("rx.refill.failed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }

  const facts = (p: Prescription) =>
    [
      p.strength && { label: "rx.strength" as MessageKey, value: p.strength },
      p.formulation && { label: "rx.formulation" as MessageKey, value: p.formulation },
      p.dose && { label: "rx.dose" as MessageKey, value: p.dose },
      p.route && { label: "rx.route" as MessageKey, value: t(`rx.route.${p.route}` as MessageKey) },
    ].filter(Boolean) as { label: MessageKey; value: string }[];

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader title={t("rx.page.title")} description={t("rx.page.intro")} />
      <p className="rounded-2xl bg-sand p-4 text-base text-sand-foreground">{t("rx.notSentNote")}</p>

      <QueryState query={query} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title={t("rx.empty.title")}>{t("rx.empty.body")}</EmptyBlock>}>
        {(all) => {
          const active = all.filter((p) => p.status === "active");
          const past = all.filter((p) => p.status !== "active");
          return (
            <>
              {active.length > 0 && (
                <section aria-labelledby="active-heading" className="space-y-4">
                  <h2 id="active-heading" className="text-2xl font-semibold">{t("rx.current")}</h2>
                  <ul className="space-y-4">
                    {active.map((p) => (
                      <li key={p.id}>
                        <Card>
                          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                            <div className="min-w-0">
                              <CardTitle as="h3" className="text-2xl leading-snug">{p.medicationName}</CardTitle>
                              <CardDescription className="text-base">
                                {t("rx.from", { name: p.doctor?.name ?? "" })}{p.doctor?.specialty ? ` (${specialtyLabel(t, p.doctor.specialty)})` : ""}
                              </CardDescription>
                            </div>
                            <StatusBadge kind="prescription" status={p.status} />
                          </CardHeader>
                          <CardContent className="space-y-4">
                            {facts(p).length > 0 && (
                              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                                {facts(p).map((f) => (
                                  <div key={f.label}><dt className="text-base font-semibold text-muted-foreground">{t(f.label)}</dt><dd className="text-lg"><bdi>{f.value}</bdi></dd></div>
                                ))}
                              </dl>
                            )}
                            <div>
                              <p className="text-lg">{p.instructions}</p>
                              <ExplainSimplyButton text={p.instructions} />
                            </div>
                            {p.warnings && <p className="rounded-xl border-2 border-ochre bg-sand p-3 text-sand-foreground"><strong>{t("rx.warnings")}:</strong> {p.warnings}</p>}
                            <p className="text-muted-foreground">
                              {t("rx.started", { date: formatDate(p.startDate) })}{p.endDate ? ` · ${t("rx.ends", { date: formatDate(p.endDate) })}` : ""} · {t("rx.refillsLeft", { left: p.refillsAllowed - p.refillsUsed, total: p.refillsAllowed })}
                            </p>
                            {p.authorizedAt && <p className="text-base text-muted-foreground">{t("rx.authorizedOn", { date: formatDate(p.authorizedAt), name: p.doctor?.name ?? "" })}</p>}
                            <div className="flex flex-wrap gap-3">
                              {!p.tracked && (
                                <Button variant="outline" disabled={busyId === p.id} onClick={() => track(p.id)}>
                                  <Pill aria-hidden="true" /> {t("rx.track")}<span className="sr-only">: {p.medicationName}</span>
                                </Button>
                              )}
                              {p.refillsAllowed > p.refillsUsed && (
                                <ConfirmAction
                                  trigger={<Button variant="outline"><RefreshCw aria-hidden="true" /> {t("rx.refill")}<span className="sr-only">: {p.medicationName}</span></Button>}
                                  title={t("rx.refill.title", { name: p.doctor?.name ?? "" })}
                                  description={t("rx.refill.body", { name: p.doctor?.name ?? "" })}
                                  confirmLabel={t("rx.refill.yes")}
                                  cancelLabel={t("rx.refill.no")}
                                  onConfirm={() => askForRefill(p)}
                                />
                              )}
                              {config?.demoMode && (
                                <Button asChild variant="outline">
                                  <Link href={`/pharmacy?prescription=${p.id}`}><Truck aria-hidden="true" /> {t("rx.pharmacyDemo")}</Link>
                                </Button>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {past.length > 0 && (
                <section aria-labelledby="past-heading" className="space-y-4">
                  <h2 id="past-heading" className="text-2xl font-semibold">{t("rx.past")}</h2>
                  <ul className="space-y-4">
                    {past.map((p) => (
                      <li key={p.id}>
                        <Card>
                          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                            <CardTitle as="h3" className="text-xl">{p.medicationName}</CardTitle>
                            <StatusBadge kind="prescription" status={p.status} />
                          </CardHeader>
                          <CardContent><p className="text-lg text-muted-foreground">{p.instructions}</p></CardContent>
                        </Card>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
