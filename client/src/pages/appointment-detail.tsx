import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Plus, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import StatusBadge from "@/components/status-badge";
import ExplainSimplyButton from "@/components/explain-simply-button";
import QueryState from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatRelativeDay, formatDateTime } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { specialtyLabel } from "@/lib/labels";
import { appointmentTypeLabel } from "@/lib/labels";

interface Prepare {
  appointment: { id: string; type: string; reason: string; scheduledAt: string; status: string; doctorNotes: string | null; followUpInstructions: string | null };
  doctor: { name: string; specialty: string; bio: string | null } | null;
  questionsForDoctor: string[];
  activeMedications: { id: string; name: string; instructions: string }[];
  activePrescriptions: { id: string; medicationName: string; instructions: string }[];
  recentDocuments: { id: string; title: string; category: string }[];
  recentMessages: { senderUserId: string; body: string; createdAt: string }[];
}

const HOW_IT_HAPPENS: Record<string, MessageKey> = {
  "Video Visit": "pt.apptd.how.video",
  "Phone Call": "pt.apptd.how.phone",
  "In-Person": "pt.apptd.how.inPerson",
};

const WHEN_STATUS: Record<string, MessageKey> = {
  requested: "pt.apptd.when.requested",
  confirmed: "pt.apptd.when.confirmed",
};

export default function AppointmentDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");
  const query = useQuery<Prepare>({ queryKey: [`/api/appointments/${id}/prepare`] });

  async function saveQuestions(next: string[]) {
    try {
      await apiRequest("PATCH", `/api/appointments/${id}/questions`, { questionsForDoctor: next });
      queryClient.invalidateQueries({ queryKey: [`/api/appointments/${id}/prepare`] });
    } catch (err: any) {
      toast({ title: t("pt.saveFail"), description: err.message, variant: "destructive" });
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="outline">
        <Link href="/appointments"><ArrowLeft aria-hidden="true" className="flip-rtl" /> {t("pt.apptd.all")}</Link>
      </Button>

      <QueryState query={query} loadingLabel={t("pt.apptd.loading")}>
        {(data) => {
          const { appointment, doctor } = data;
          const live = appointment.status === "requested" || appointment.status === "confirmed";
          return (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-3xl font-semibold">{formatRelativeDay(appointment.scheduledAt)}</h1>
                  <p className="text-lg text-muted-foreground">{doctor?.specialty
                      ? t("pt.apptd.typeWithSpec", { type: appointmentTypeLabel(t, appointment.type), doctor: doctor.name, specialty: specialtyLabel(t, doctor.specialty) })
                      : t("pt.appt.typeWith", { type: appointmentTypeLabel(t, appointment.type), doctor: doctor?.name ?? "" })}</p>
                </div>
                <StatusBadge kind="appointment" status={appointment.status} />
              </div>

              {appointment.status === "completed" ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-2xl">{t("pt.apptd.doctorWrote")}</CardTitle>
                    <CardDescription className="text-base">{t("pt.apptd.writtenBy", { name: doctor?.name ?? "" })}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="whitespace-pre-wrap text-lg">{appointment.doctorNotes}</p>
                      {appointment.doctorNotes && <ExplainSimplyButton text={appointment.doctorNotes} />}
                    </div>
                    {appointment.followUpInstructions && (
                      <div className="rounded-xl border-2 border-input bg-secondary p-4">
                        <h2 className="text-lg font-semibold">{t("pt.apptd.next")}</h2>
                        <p className="mt-1 whitespace-pre-wrap text-lg">{appointment.followUpInstructions}</p>
                        <ExplainSimplyButton text={appointment.followUpInstructions} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              ) : live ? (
                <>
                  <section aria-labelledby="how" className="space-y-2 rounded-xl border-2 border-input bg-card p-4">
                    <h2 id="how" className="text-xl font-semibold">{t("pt.apptd.how")}</h2>
                    <p className="text-lg">{t(HOW_IT_HAPPENS[appointment.type] ?? "pt.apptd.how.default")}</p>
                    <p className="text-lg text-muted-foreground">{WHEN_STATUS[appointment.status] ? `${t(WHEN_STATUS[appointment.status])} ` : ""}{t("pt.apptd.diffTime")}</p>
                  </section>

                  <Card>
                    <CardHeader>
                      <CardTitle as="h2" className="text-2xl">{t("pt.getReady")}</CardTitle>
                      <CardDescription className="text-base">{t("pt.apptd.getReadyDesc")}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div>
                        <h3 className="text-lg font-semibold">{t("pt.apptd.about")}</h3>
                        <p className="text-lg text-muted-foreground">{appointment.reason}</p>
                      </div>

                      <div>
                        <h3 className="text-lg font-semibold">{t("pt.apptd.questions")}</h3>
                        <ul className="mt-2 space-y-2">
                          {data.questionsForDoctor.map((q, i) => (
                            <li key={i} className="flex items-center justify-between gap-2 rounded-xl border-2 border-input bg-card px-4 py-2 text-lg">
                              <span>{q}</span>
                              <Button variant="ghost" size="icon" onClick={() => saveQuestions(data.questionsForDoctor.filter((_, j) => j !== i))}>
                                <X aria-hidden="true" /><span className="sr-only">{t("pt.apptd.removeQ", { question: q })}</span>
                              </Button>
                            </li>
                          ))}
                        </ul>
                        <form
                          className="mt-3 space-y-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!question.trim()) return;
                            saveQuestions([...data.questionsForDoctor, question.trim()]);
                            setQuestion("");
                          }}
                        >
                          <Label htmlFor="new-question" className="text-base">{t("pt.apptd.addQ")}</Label>
                          <div className="flex gap-3">
                            <Input id="new-question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} />
                            <Button type="submit" size="lg"><Plus aria-hidden="true" /> {t("pt.apptd.add")}</Button>
                          </div>
                        </form>
                      </div>

                      {data.activeMedications.length > 0 && (
                        <div>
                          <h3 className="text-lg font-semibold">{t("pt.apptd.meds")}</h3>
                          <ul className="mt-1 list-disc space-y-1 ps-6 text-lg text-muted-foreground">
                            {data.activeMedications.map((m) => <li key={m.id}>{t("pt.apptd.medItem", { name: m.name, instructions: m.instructions })}</li>)}
                          </ul>
                        </div>
                      )}

                      {data.recentDocuments.length > 0 && (
                        <div>
                          <h3 className="text-lg font-semibold">{t("pt.apptd.papers")}</h3>
                          <ul className="mt-1 list-disc space-y-1 ps-6 text-lg text-muted-foreground">
                            {data.recentDocuments.map((d) => <li key={d.id}>{t("pt.apptd.docItem", { title: d.title, category: d.category })}</li>)}
                          </ul>
                        </div>
                      )}

                      {data.recentMessages.length > 0 && (
                        <div>
                          <h3 className="text-lg font-semibold">{t("pt.apptd.recent")}</h3>
                          <ul className="mt-1 space-y-2 text-lg text-muted-foreground">
                            {data.recentMessages.map((m, i) => <li key={i}>{t("pt.apptd.msgItem", { body: m.body, when: formatDateTime(m.createdAt) })}</li>)}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              ) : (
                <p className="rounded-xl border-2 border-input bg-card p-4 text-lg">{t("pt.apptd.cancelled")}</p>
              )}
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
