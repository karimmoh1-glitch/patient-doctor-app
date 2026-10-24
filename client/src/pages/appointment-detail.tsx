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

interface Prepare {
  appointment: { id: string; type: string; reason: string; scheduledAt: string; status: string; doctorNotes: string | null; followUpInstructions: string | null };
  doctor: { name: string; specialty: string; bio: string | null } | null;
  questionsForDoctor: string[];
  activeMedications: { id: string; name: string; instructions: string }[];
  activePrescriptions: { id: string; medicationName: string; instructions: string }[];
  recentDocuments: { id: string; title: string; category: string }[];
  recentMessages: { senderUserId: string; body: string; createdAt: string }[];
}

const HOW_IT_HAPPENS: Record<string, string> = {
  "Video Visit": "Video calling is not built into Avela yet. Your doctor will phone you or send you a link at the time of your visit. Keep your phone nearby and switched on.",
  "Phone Call": "Your doctor will phone you at the time of your visit. Keep your phone nearby and switched on.",
  "In-Person": "You will meet your doctor in person. Ask the doctor's office for the address if you don't have it.",
};

const WHEN_STATUS: Record<string, string> = {
  requested: "Your doctor hasn't confirmed this time yet.",
  confirmed: "Your doctor has confirmed this time.",
};

export default function AppointmentDetail({ id }: { id: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");
  const query = useQuery<Prepare>({ queryKey: [`/api/appointments/${id}/prepare`] });

  async function saveQuestions(next: string[]) {
    try {
      await apiRequest("PATCH", `/api/appointments/${id}/questions`, { questionsForDoctor: next });
      queryClient.invalidateQueries({ queryKey: [`/api/appointments/${id}/prepare`] });
    } catch (err: any) {
      toast({ title: "We couldn't save that", description: err.message, variant: "destructive" });
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="outline">
        <Link href="/appointments"><ArrowLeft aria-hidden="true" /> All appointments</Link>
      </Button>

      <QueryState query={query} loadingLabel="Loading your visit">
        {(data) => {
          const { appointment, doctor } = data;
          const live = appointment.status === "requested" || appointment.status === "confirmed";
          return (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-3xl font-semibold">{formatRelativeDay(appointment.scheduledAt)}</h1>
                  <p className="text-lg text-muted-foreground">{appointment.type} with {doctor?.name}{doctor?.specialty ? ` (${doctor.specialty})` : ""}</p>
                </div>
                <StatusBadge kind="appointment" status={appointment.status} />
              </div>

              {appointment.status === "completed" ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-2xl">What your doctor wrote</CardTitle>
                    <CardDescription className="text-base">Written by {doctor?.name}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="whitespace-pre-wrap text-lg">{appointment.doctorNotes}</p>
                      {appointment.doctorNotes && <ExplainSimplyButton text={appointment.doctorNotes} />}
                    </div>
                    {appointment.followUpInstructions && (
                      <div className="rounded-xl border-2 border-input bg-secondary p-4">
                        <h2 className="text-lg font-semibold">What to do next</h2>
                        <p className="mt-1 whitespace-pre-wrap text-lg">{appointment.followUpInstructions}</p>
                        <ExplainSimplyButton text={appointment.followUpInstructions} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              ) : live ? (
                <>
                  <section aria-labelledby="how" className="space-y-2 rounded-xl border-2 border-input bg-card p-4">
                    <h2 id="how" className="text-xl font-semibold">How this visit will happen</h2>
                    <p className="text-lg">{HOW_IT_HAPPENS[appointment.type] ?? "Your doctor will be in touch at the time of your visit."}</p>
                    <p className="text-lg text-muted-foreground">{WHEN_STATUS[appointment.status]} Need a different time? Go back and choose "Change time".</p>
                  </section>

                  <Card>
                    <CardHeader>
                      <CardTitle as="h2" className="text-2xl">Get ready</CardTitle>
                      <CardDescription className="text-base">Your own information, in one place. It is not medical advice.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div>
                        <h3 className="text-lg font-semibold">What the visit is about</h3>
                        <p className="text-lg text-muted-foreground">{appointment.reason}</p>
                      </div>

                      <div>
                        <h3 className="text-lg font-semibold">Questions I want to ask</h3>
                        <ul className="mt-2 space-y-2">
                          {data.questionsForDoctor.map((q, i) => (
                            <li key={i} className="flex items-center justify-between gap-2 rounded-xl border-2 border-input bg-card px-4 py-2 text-lg">
                              <span>{q}</span>
                              <Button variant="ghost" size="icon" onClick={() => saveQuestions(data.questionsForDoctor.filter((_, j) => j !== i))}>
                                <X aria-hidden="true" /><span className="sr-only">Remove the question: {q}</span>
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
                          <Label htmlFor="new-question" className="text-base">Add a question</Label>
                          <div className="flex gap-3">
                            <Input id="new-question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} />
                            <Button type="submit" size="lg"><Plus aria-hidden="true" /> Add</Button>
                          </div>
                        </form>
                      </div>

                      {data.activeMedications.length > 0 && (
                        <div>
                          <h3 className="text-lg font-semibold">The medicines I take</h3>
                          <ul className="mt-1 list-disc space-y-1 pl-6 text-lg text-muted-foreground">
                            {data.activeMedications.map((m) => <li key={m.id}>{m.name}: {m.instructions}</li>)}
                          </ul>
                        </div>
                      )}

                      {data.recentDocuments.length > 0 && (
                        <div>
                          <h3 className="text-lg font-semibold">Papers I might want to talk about</h3>
                          <ul className="mt-1 list-disc space-y-1 pl-6 text-lg text-muted-foreground">
                            {data.recentDocuments.map((d) => <li key={d.id}>{d.title} ({d.category})</li>)}
                          </ul>
                        </div>
                      )}

                      {data.recentMessages.length > 0 && (
                        <div>
                          <h3 className="text-lg font-semibold">Recent messages</h3>
                          <ul className="mt-1 space-y-2 text-lg text-muted-foreground">
                            {data.recentMessages.map((m, i) => <li key={i}>"{m.body}" ({formatDateTime(m.createdAt)})</li>)}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              ) : (
                <p className="rounded-xl border-2 border-input bg-card p-4 text-lg">This visit was cancelled.</p>
              )}
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
