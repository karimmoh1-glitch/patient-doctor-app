import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Pill, Truck, FileText, CheckCircle2, AlertCircle, Circle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import StatusBadge from "@/components/status-badge";
import QueryState, { EmptyBlock, LoadingBlock, ErrorBlock } from "@/components/query-state";
import { formatRelativeDay, formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AuthUser } from "@/hooks/use-auth";

interface CarePatient {
  careCircleMemberId: string;
  patientUserId: string;
  patientName: string;
  relationshipLabel: string;
  permissions: { medicationStatus: boolean; appointments: boolean; deliveryStatus: boolean; documents: boolean; fullRecords: boolean };
}

interface Overview {
  patientName: string;
  todaysMedicationStatus?: { medicationName: string; time: string; status: string }[];
  upcomingAppointments?: { type: string; scheduledAt: string; status: string; doctorName: string }[];
  pharmacyOrders?: { medicationName: string; status: string; fulfillmentType: string }[];
  documents?: { title: string; category: string; createdAt: string }[];
}

// The app only ever knows what the patient told it. These words say so.
const DOSE_LABEL: Record<string, string> = {
  taken: "Marked as taken",
  skipped: "Skipped",
  not_confirmed: "Not marked yet, and the time has passed",
  upcoming: "Not due yet",
};

function DoseIcon({ status }: { status: string }) {
  if (status === "taken") return <CheckCircle2 className="h-6 w-6 text-primary" aria-hidden="true" />;
  if (status === "not_confirmed") return <AlertCircle className="h-6 w-6 text-destructive" aria-hidden="true" />;
  return <Circle className="h-6 w-6 text-muted-foreground" aria-hidden="true" />;
}

function Section({ icon: Icon, title, description, children }: { icon: React.ComponentType<{ className?: string }>; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2 text-xl"><Icon className="h-5 w-5 text-primary" aria-hidden="true" /> {title}</CardTitle>
        {description && <CardDescription className="text-base">{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

export default function CaregiverDashboard({ user }: { user: AuthUser }) {
  const patientsQuery = useQuery<CarePatient[]>({ queryKey: ["/api/care-circle/caregiver/patients"] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const patients = patientsQuery.data || [];
  const selected = patients.find((p) => p.patientUserId === selectedId) || patients[0];

  const overviewQuery = useQuery<Overview>({
    queryKey: [`/api/care-circle/caregiver/patients/${selected?.patientUserId}/overview`],
    enabled: !!selected,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Hello, {user.name.split(" ")[0]}</h1>
        <p className="text-lg text-muted-foreground">You can see only what each person has chosen to share with you. You can look, but you can't change anything.</p>
      </div>

      <QueryState
        query={patientsQuery}
        isEmpty={(p) => p.length === 0}
        empty={<EmptyBlock title="Nobody has shared anything with you yet">When someone adds you to their Care Circle, they will appear here.</EmptyBlock>}
      >
        {(list) => (
          <>
            {list.length > 1 && (
              <div role="radiogroup" aria-label="Whose information to show" className="flex flex-wrap gap-3">
                {list.map((p) => (
                  <button
                    key={p.patientUserId}
                    type="button"
                    role="radio"
                    aria-checked={selected?.patientUserId === p.patientUserId}
                    onClick={() => setSelectedId(p.patientUserId)}
                    className={cn(
                      "min-h-12 rounded-full border-2 px-5 text-lg font-semibold",
                      selected?.patientUserId === p.patientUserId ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card",
                    )}
                  >
                    {p.patientName}
                  </button>
                ))}
              </div>
            )}

            {selected && (
              <div className="space-y-5">
                <p className="rounded-xl border-2 border-input bg-card p-4 text-lg">
                  You are looking at <strong>{selected.patientName}</strong>'s information, as their <strong>{selected.relationshipLabel}</strong>.
                </p>

                {overviewQuery.isLoading && <LoadingBlock label={`Loading ${selected.patientName}'s information`} />}
                {overviewQuery.isError && <ErrorBlock error={overviewQuery.error} onRetry={() => overviewQuery.refetch()} />}

                {overviewQuery.data && (
                  <>
                    {selected.permissions.medicationStatus && overviewQuery.data.todaysMedicationStatus && (
                      <Section icon={Pill} title="Today's medicines" description="What they have marked on their phone. It does not prove anything was or wasn't taken.">
                        {overviewQuery.data.todaysMedicationStatus.length === 0 && <p className="text-lg text-muted-foreground">Nothing is scheduled today.</p>}
                        {overviewQuery.data.todaysMedicationStatus.map((d, i) => (
                          <div key={i} className="flex items-center gap-3 border-b border-border py-2 last:border-0">
                            <DoseIcon status={d.status} />
                            <div>
                              <p className="text-lg font-semibold">{d.medicationName} at {formatClock(d.time)}</p>
                              <p className="text-muted-foreground">{DOSE_LABEL[d.status] ?? d.status}</p>
                            </div>
                          </div>
                        ))}
                      </Section>
                    )}

                    {selected.permissions.appointments && overviewQuery.data.upcomingAppointments && (
                      <Section icon={CalendarDays} title="Coming up">
                        {overviewQuery.data.upcomingAppointments.length === 0 && <p className="text-lg text-muted-foreground">No visits are booked.</p>}
                        {overviewQuery.data.upcomingAppointments.map((a, i) => (
                          <div key={i} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 last:border-0">
                            <div>
                              <p className="text-lg font-semibold">{formatRelativeDay(a.scheduledAt)}</p>
                              <p className="text-muted-foreground">{a.type} with {a.doctorName}</p>
                            </div>
                            <StatusBadge kind="appointment" status={a.status} />
                          </div>
                        ))}
                      </Section>
                    )}

                    {selected.permissions.deliveryStatus && overviewQuery.data.pharmacyOrders && overviewQuery.data.pharmacyOrders.length > 0 && (
                      <Section icon={Truck} title="Pharmacy orders" description="Example orders only, if this is a demonstration.">
                        {overviewQuery.data.pharmacyOrders.map((o, i) => (
                          <div key={i} className="flex flex-wrap items-center justify-between gap-2 py-1">
                            <p className="text-lg font-semibold">{o.medicationName}</p>
                            <StatusBadge kind="pharmacyOrder" status={o.status} />
                          </div>
                        ))}
                      </Section>
                    )}

                    {selected.permissions.documents && overviewQuery.data.documents && (
                      <Section icon={FileText} title="Documents">
                        {overviewQuery.data.documents.length === 0 && <p className="text-lg text-muted-foreground">No documents are shared.</p>}
                        {overviewQuery.data.documents.map((d, i) => (
                          <p key={i} className="text-lg">{d.title} <span className="text-muted-foreground">· {d.category}</span></p>
                        ))}
                      </Section>
                    )}

                    {!selected.permissions.medicationStatus && !selected.permissions.appointments && !selected.permissions.deliveryStatus && !selected.permissions.documents && (
                      <EmptyBlock title={`${selected.patientName} hasn't shared anything with you yet`} />
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}
