import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Undo2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import ConfirmAction from "@/components/confirm-action";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatClock, formatDate } from "@/lib/format";

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
  const refresh = useRefresh();
  const { toast } = useToast();
  const label = `${dose.medicationName} at ${formatClock(dose.time)}`;

  async function change(run: () => Promise<unknown>, failure: string) {
    try {
      await run();
      refresh();
    } catch (err: any) {
      toast({ title: failure, description: err.message, variant: "destructive" });
    }
  }
  const log = (status: "taken" | "skipped") =>
    change(() => apiRequest("POST", `/api/medications/${dose.medicationId}/log`, { doseTime: dose.time, status }), "We couldn't save that");
  const undo = () =>
    change(() => apiRequest("DELETE", `/api/medications/${dose.medicationId}/log?doseTime=${encodeURIComponent(dose.time)}`), "We couldn't undo that");

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
                <Check aria-hidden="true" /> I took it<span className="sr-only">: {label}</span>
              </Button>
              <Button size="lg" variant="outline" onClick={() => log("skipped")}>
                I'm skipping this one<span className="sr-only">: {label}</span>
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <p role="status" className="flex items-center gap-2 text-lg font-semibold">
                {dose.status === "taken" ? (
                  <><Check className="h-6 w-6 text-primary" aria-hidden="true" /> You marked this as taken</>
                ) : (
                  <>You chose to skip this one</>
                )}
              </p>
              <Button variant="outline" onClick={undo}>
                <Undo2 aria-hidden="true" /> Undo<span className="sr-only">: {label}</span>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

export default function Medications() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const todayQuery = useQuery<{ date: string; schedule: TodayDose[] }>({ queryKey: ["/api/medications/today"] });
  const medsQuery = useQuery<Medication[]>({ queryKey: ["/api/medications"] });
  const adherenceQuery = useQuery<Adherence>({ queryKey: ["/api/medications/adherence"] });

  async function toggleActive(id: string, active: boolean) {
    try {
      await apiRequest("PATCH", `/api/medications/${id}/active`, { active });
      queryClient.invalidateQueries({ queryKey: ["/api/medications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/medications/today"] });
    } catch (err: any) {
      toast({ title: "We couldn't change that", description: err.message, variant: "destructive" });
      throw err;
    }
  }

  const adherence = adherenceQuery.data;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">Today's medicines</h1>
        <p className="mt-1 text-lg text-muted-foreground">
          This list records what you tell us. It does not change your prescription, and it does not check whether you took anything.
        </p>
        <p className="mt-2 text-muted-foreground">
          Avela does not send reminders yet. If you would like one, set an alarm on your phone.
        </p>
      </div>

      <section aria-labelledby="today-heading" className="space-y-4">
        <h2 id="today-heading" className="text-2xl font-semibold">Doses for today</h2>
        <QueryState
          query={todayQuery}
          isEmpty={(d) => d.schedule.length === 0}
          empty={<EmptyBlock title="Nothing is scheduled for today">Medicines you add from your prescriptions will show up here.</EmptyBlock>}
          loadingLabel="Loading today's medicines"
        >
          {(d) => <ul className="space-y-4">{d.schedule.map((dose) => <DoseCard key={`${dose.medicationId}-${dose.time}`} dose={dose} />)}</ul>}
        </QueryState>
      </section>

      {adherence && adherence.expectedCount > 0 && (
        <section aria-labelledby="week-heading" className="space-y-3 rounded-xl border-2 border-input bg-card p-5">
          <h2 id="week-heading" className="text-xl font-semibold">The last {adherence.windowDays} days</h2>
          <p className="text-lg">
            You marked {adherence.takenCount} of {adherence.expectedCount} doses as taken.
          </p>
          <Progress
            value={(adherence.takenCount / adherence.expectedCount) * 100}
            aria-label={`${adherence.takenCount} of ${adherence.expectedCount} doses marked as taken in the last ${adherence.windowDays} days`}
          />
        </section>
      )}

      <section aria-labelledby="all-heading" className="space-y-4">
        <h2 id="all-heading" className="text-2xl font-semibold">All my medicines</h2>
        <QueryState
          query={medsQuery}
          isEmpty={(m) => m.length === 0}
          empty={<EmptyBlock title="No medicines yet">Your doctor's prescriptions can be added from the Prescriptions page.</EmptyBlock>}
        >
          {(meds) => (
            <ul className="space-y-4">
              {meds.map((m) => (
                <li key={m.id}>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle as="h3" className="text-xl">{m.name}</CardTitle>
                      <p className="text-muted-foreground">
                        {m.active ? "Being tracked" : "Tracking is paused"}
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-lg">{m.instructions}</p>
                      <p className="text-muted-foreground">
                        At {m.scheduleTimes.map(formatClock).join(", ")} · from {formatDate(m.startDate)}{m.endDate ? ` to ${formatDate(m.endDate)}` : ""}
                      </p>
                      {m.active ? (
                        <ConfirmAction
                          trigger={<Button variant="outline">Pause tracking</Button>}
                          title={`Pause tracking ${m.name}?`}
                          description="You won't see this medicine in today's list until you turn tracking back on. This does not change your prescription or what your doctor told you to take."
                          confirmLabel="Yes, pause tracking"
                          cancelLabel="No, keep tracking"
                          onConfirm={() => toggleActive(m.id, false)}
                        />
                      ) : (
                        <Button variant="outline" onClick={() => toggleActive(m.id, true).catch(() => {})}>Turn tracking back on</Button>
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </section>
    </div>
  );
}
