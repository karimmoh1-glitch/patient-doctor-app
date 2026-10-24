import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { RefreshCw, Pill, Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/status-badge";
import ExplainSimplyButton from "@/components/explain-simply-button";
import ConfirmAction from "@/components/confirm-action";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAppConfig } from "@/hooks/use-app-config";
import { formatDate } from "@/lib/format";

interface Prescription {
  id: string;
  medicationName: string;
  instructions: string;
  frequencyPerDay: number;
  refillsAllowed: number;
  refillsUsed: number;
  status: string;
  startDate: string;
  endDate: string | null;
  doctor: { name: string; specialty: string } | null;
  tracked: boolean;
}

export default function Prescriptions() {
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
      toast({ title: "Added to today's medicines" });
    } catch (err: any) {
      toast({ title: "We couldn't add it", description: err.message, variant: "destructive" });
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
        title: data.notifiedDoctor ? `Message sent to ${p.doctor?.name}` : "Request saved",
        description: data.notifiedDoctor
          ? "They will decide, and reply when they can. Nothing has been sent to a pharmacy."
          : "We couldn't reach your doctor through Avela. Please phone their office.",
      });
    } catch (err: any) {
      toast({ title: "We couldn't ask for the refill", description: err.message, variant: "destructive" });
      throw err;
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">Prescriptions</h1>
        <p className="text-lg text-muted-foreground">Medicines your doctors have recorded in Avela. Follow what your doctor and pharmacist told you.</p>
      </div>

      <QueryState query={query} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title="No prescriptions yet">When a doctor records one for you, it will appear here.</EmptyBlock>}>
        {(all) => {
          const active = all.filter((p) => p.status === "active");
          const past = all.filter((p) => p.status !== "active");
          return (
            <>
              {active.length > 0 && (
                <section aria-labelledby="active-heading" className="space-y-4">
                  <h2 id="active-heading" className="text-2xl font-semibold">Current</h2>
                  <ul className="space-y-4">
                    {active.map((p) => (
                      <li key={p.id}>
                        <Card>
                          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                            <div>
                              <CardTitle as="h3" className="text-2xl leading-snug">{p.medicationName}</CardTitle>
                              <CardDescription className="text-base">From {p.doctor?.name}{p.doctor?.specialty ? ` (${p.doctor.specialty})` : ""}</CardDescription>
                            </div>
                            <StatusBadge kind="prescription" status={p.status} />
                          </CardHeader>
                          <CardContent className="space-y-4">
                            <div>
                              <p className="text-lg">{p.instructions}</p>
                              <ExplainSimplyButton text={p.instructions} />
                            </div>
                            <p className="text-muted-foreground">
                              Started {formatDate(p.startDate)}{p.endDate ? ` · ends ${formatDate(p.endDate)}` : ""} · {p.refillsAllowed - p.refillsUsed} of {p.refillsAllowed} refills left
                            </p>
                            <div className="flex flex-wrap gap-3">
                              {!p.tracked && (
                                <Button variant="outline" disabled={busyId === p.id} onClick={() => track(p.id)}>
                                  <Pill aria-hidden="true" /> Add to today's medicines<span className="sr-only">: {p.medicationName}</span>
                                </Button>
                              )}
                              {p.refillsAllowed > p.refillsUsed && (
                                <ConfirmAction
                                  trigger={<Button variant="outline"><RefreshCw aria-hidden="true" /> Ask for a refill<span className="sr-only">: {p.medicationName}</span></Button>}
                                  title={`Ask ${p.doctor?.name} for a refill?`}
                                  description={`This sends ${p.doctor?.name} a message in Avela. They decide whether to approve it and may take a day or more. It does not reach a pharmacy, so don't wait if you are about to run out. Phone your doctor's office or pharmacist.`}
                                  confirmLabel="Yes, send the message"
                                  cancelLabel="No, not now"
                                  onConfirm={() => askForRefill(p)}
                                />
                              )}
                              {config?.demoMode && (
                                <Button asChild variant="outline">
                                  <Link href={`/pharmacy?prescription=${p.id}`}><Truck aria-hidden="true" /> Try the example pharmacy</Link>
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
                  <h2 id="past-heading" className="text-2xl font-semibold">Past</h2>
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
