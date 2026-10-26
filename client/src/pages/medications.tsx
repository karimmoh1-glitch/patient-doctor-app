import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Check, TriangleAlert, Undo2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import ConfirmAction from "@/components/confirm-action";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import ReminderEditor, { type ReminderState } from "@/components/reminder-editor";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatClock, formatDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

interface TodayDose {
  medicationId: string;
  medicationName: string;
  instructions: string;
  time: string;
  status: string;
}

interface Medication {
  id: string;
  name: string;
  instructions: string;
  scheduleTimes: string[];
  startDate: string;
  endDate: string | null;
  active: boolean;
}

interface ReminderListing {
  delivery: "active" | "stale" | "failing" | "not_configured";
  emailAvailable: boolean;
  emailNeedsConfirmation?: boolean;
  medications: { medicationId: string; suggestedTimes: string[]; reminder: ReminderState | null }[];
}

interface Adherence {
  takenCount: number;
  expectedCount: number;
  windowDays: number;
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["/api/medications/today"] });
    queryClient.invalidateQueries({ queryKey: ["/api/medications/adherence"] });
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
  };
}

function DoseCard({ dose }: { dose: TodayDose }) {
  const { t } = useI18n();
  const refresh = useRefresh();
  const { toast } = useToast();
  const label = t("med.doseLabel", { name: dose.medicationName, time: formatClock(dose.time) });

  async function change(run: () => Promise<unknown>, failure: string) {
    try {
      await run();
      refresh();
    } catch (err: any) {
      toast({ title: failure, description: err.message, variant: "destructive" });
    }
  }
  const log = (status: "taken" | "skipped") =>
    change(() => apiRequest("POST", `/api/medications/${dose.medicationId}/log`, { doseTime: dose.time, status }), t("med.saveFailed"));
  const undo = () =>
    change(() => apiRequest("DELETE", `/api/medications/${dose.medicationId}/log?doseTime=${encodeURIComponent(dose.time)}`), t("med.undoFailed"));

  return (
    <li>
      <Card>
        <CardHeader className="pb-2">
          <p className="text-xl font-semibold">{formatClock(dose.time)}</p>
          <CardTitle as="h3" className="text-2xl leading-snug">{dose.medicationName}</CardTitle>
          <p className="text-lg text-muted-foreground">{dose.instructions}</p>
        </CardHeader>
        <CardContent>
          {dose.status === "upcoming" ? (
            <div className="flex flex-wrap gap-3">
              <Button size="lg" onClick={() => log("taken")}>
                <Check aria-hidden="true" /> {t("med.tookIt")}<span className="sr-only">: {label}</span>
              </Button>
              <Button size="lg" variant="outline" onClick={() => log("skipped")}>
                {t("med.skipping")}<span className="sr-only">: {label}</span>
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <p role="status" className="flex items-center gap-2 text-lg font-semibold">
                {dose.status === "taken" ? (
                  <><Check className="h-6 w-6 text-primary" aria-hidden="true" /> {t("med.markedTaken")}</>
                ) : (
                  <>{t("med.markedSkipped")}</>
                )}
              </p>
              <Button variant="outline" onClick={undo}>
                <Undo2 aria-hidden="true" /> {t("med.undo")}<span className="sr-only">: {label}</span>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

// Says plainly whether reminders are actually being sent right now. They are
// saved either way, but a saved reminder that nothing delivers must not look
// like a working one.
function DeliveryNotice({ delivery }: { delivery: ReminderListing["delivery"] }) {
  const { t } = useI18n();
  if (delivery === "active") {
    return (
      <p role="status" className="flex items-start gap-3 rounded-xl bg-secondary p-4 text-base">
        <BellRing className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" /> {t("rem.delivery.active")}
      </p>
    );
  }
  return (
    <p role="status" className="flex items-start gap-3 rounded-xl border-2 border-ochre bg-sand p-4 text-base text-sand-foreground">
      <TriangleAlert className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
      {delivery === "failing" ? t("rem.delivery.failing") : delivery === "stale" ? t("rem.delivery.stale") : t("rem.delivery.off")}
    </p>
  );
}

export default function Medications() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const todayQuery = useQuery<{ date: string; schedule: TodayDose[] }>({ queryKey: ["/api/medications/today"] });
  const medsQuery = useQuery<Medication[]>({ queryKey: ["/api/medications"] });
  const adherenceQuery = useQuery<Adherence>({ queryKey: ["/api/medications/adherence"] });
  const remindersQuery = useQuery<ReminderListing>({ queryKey: ["/api/reminders"], staleTime: 0 });
  const reminderFor = (id: string) => remindersQuery.data?.medications.find((m) => m.medicationId === id);

  async function toggleActive(id: string, active: boolean) {
    try {
      await apiRequest("PATCH", `/api/medications/${id}/active`, { active });
      queryClient.invalidateQueries({ queryKey: ["/api/medications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/medications/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reminders"] });
    } catch (err: any) {
      toast({ title: t("med.changeFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }

  const adherence = adherenceQuery.data;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-3">
        <PageHeader title={t("med.title")} description={t("med.intro")} />
        {remindersQuery.data && <DeliveryNotice delivery={remindersQuery.data.delivery} />}
      </div>

      <section aria-labelledby="today-heading" className="space-y-4">
        <h2 id="today-heading" className="text-2xl font-semibold">{t("med.today")}</h2>
        <QueryState
          query={todayQuery}
          isEmpty={(d) => d.schedule.length === 0}
          empty={<EmptyBlock title={t("med.today.empty")}>{t("med.today.emptyBody")}</EmptyBlock>}
          loadingLabel={t("med.today.loading")}
        >
          {(d) => <ul className="space-y-4">{d.schedule.map((dose) => <DoseCard key={`${dose.medicationId}-${dose.time}`} dose={dose} />)}</ul>}
        </QueryState>
      </section>

      {adherence && adherence.expectedCount > 0 && (
        <section aria-labelledby="week-heading" className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-soft">
          <h2 id="week-heading" className="text-xl font-semibold">{t("med.lastDays", { count: adherence.windowDays })}</h2>
          <p className="text-lg">{t("med.markedOf", { taken: adherence.takenCount, expected: adherence.expectedCount })}</p>
          <Progress
            value={(adherence.takenCount / adherence.expectedCount) * 100}
            aria-label={t("med.progressLabel", { taken: adherence.takenCount, expected: adherence.expectedCount, days: adherence.windowDays })}
          />
        </section>
      )}

      <section aria-labelledby="all-heading" className="space-y-4">
        <h2 id="all-heading" className="text-2xl font-semibold">{t("med.all")}</h2>
        <QueryState
          query={medsQuery}
          isEmpty={(m) => m.length === 0}
          empty={<EmptyBlock title={t("med.none")}>{t("med.noneBody")}</EmptyBlock>}
        >
          {(meds) => (
            <ul className="space-y-4">
              {meds.map((m) => {
                const rem = reminderFor(m.id);
                return (
                  <li key={m.id}>
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle as="h3" className="text-xl">{m.name}</CardTitle>
                        <p className="text-muted-foreground">{m.active ? t("med.tracked") : t("med.paused")}</p>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <p className="text-lg">{m.instructions}</p>
                        <p className="text-muted-foreground">
                          {t("med.schedule", { times: m.scheduleTimes.map(formatClock).join(", "), from: formatDate(m.startDate) })}
                          {m.endDate ? ` ${t("med.until", { date: formatDate(m.endDate) })}` : ""}
                        </p>
                        {m.active && remindersQuery.data && (
                          <ReminderEditor
                            medicationId={m.id}
                            medicationName={m.name}
                            suggestedTimes={rem?.suggestedTimes ?? m.scheduleTimes}
                            reminder={rem?.reminder ?? null}
                            emailAvailable={remindersQuery.data.emailAvailable}
                            emailNeedsConfirmation={remindersQuery.data.emailNeedsConfirmation}
                          />
                        )}
                        {m.active ? (
                          <ConfirmAction
                            trigger={<Button variant="outline">{t("med.pause")}</Button>}
                            title={t("med.pause.title", { name: m.name })}
                            description={t("med.pause.body")}
                            confirmLabel={t("med.pause.yes")}
                            cancelLabel={t("med.pause.no")}
                            onConfirm={() => toggleActive(m.id, false)}
                          />
                        ) : (
                          <Button variant="outline" onClick={() => toggleActive(m.id, true).catch(() => {})}>{t("med.resume")}</Button>
                        )}
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryState>
      </section>
    </div>
  );
}
