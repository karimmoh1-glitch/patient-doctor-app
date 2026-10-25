import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Pill, Truck, FileText, CheckCircle2, AlertCircle, Circle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import StatusBadge from "@/components/status-badge";
import QueryState, { EmptyBlock, LoadingBlock, ErrorBlock } from "@/components/query-state";
import { formatRelativeDay, formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useI18n, type MessageKey } from "@/lib/i18n";
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
const DOSE_LABEL: Record<string, MessageKey> = {
  taken: "caregiver.dose.taken",
  skipped: "caregiver.dose.skipped",
  not_confirmed: "caregiver.dose.not_confirmed",
  upcoming: "caregiver.dose.upcoming",
};

// Stored values stay as the server keeps them; only what the reader sees is translated.
const DOC_CATEGORY: Record<string, MessageKey> = {
  "Lab Result": "docs.category.lab_result",
  Imaging: "docs.category.imaging",
  "Visit Summary": "docs.category.visit_summary",
  Insurance: "docs.category.insurance",
  Other: "docs.category.other",
};
const APPT_TYPE: Record<string, MessageKey> = {
  "Video Visit": "health.apptType.video",
  "Phone Call": "health.apptType.phone",
  "In-Person": "health.apptType.inPerson",
};

/** Fills {name}-style markers in a translation with elements (for bold text inside a sentence). */
function rich(template: string, parts: Record<string, React.ReactNode>) {
  return template.split(/(\{\w+\})/g).map((chunk, i) => {
    const key = chunk.match(/^\{(\w+)\}$/)?.[1];
    return key && key in parts ? <Fragment key={i}>{parts[key]}</Fragment> : chunk;
  });
}

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
  const { t } = useI18n();
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
        <h1 className="text-3xl font-semibold">{t("caregiver.hello", { name: user.name.split(" ")[0] })}</h1>
        <p className="text-lg text-muted-foreground">{t("caregiver.intro")}</p>
      </div>

      <QueryState
        query={patientsQuery}
        isEmpty={(p) => p.length === 0}
        empty={<EmptyBlock title={t("caregiver.empty")}>{t("caregiver.emptyBody")}</EmptyBlock>}
      >
        {(list) => (
          <>
            {list.length > 1 && (
              <div role="radiogroup" aria-label={t("caregiver.whose")} className="flex flex-wrap gap-3">
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
                  {rich(t("caregiver.looking"), { name: <strong>{selected.patientName}</strong>, relationship: <strong>{selected.relationshipLabel}</strong> })}
                </p>

                {overviewQuery.isLoading && <LoadingBlock label={t("caregiver.loading", { name: selected.patientName })} />}
                {overviewQuery.isError && <ErrorBlock error={overviewQuery.error} onRetry={() => overviewQuery.refetch()} />}

                {overviewQuery.data && (
                  <>
                    {selected.permissions.medicationStatus && overviewQuery.data.todaysMedicationStatus && (
                      <Section icon={Pill} title={t("health.todaysMedicines")} description={t("caregiver.meds.desc")}>
                        {overviewQuery.data.todaysMedicationStatus.length === 0 && <p className="text-lg text-muted-foreground">{t("caregiver.meds.none")}</p>}
                        {overviewQuery.data.todaysMedicationStatus.map((d, i) => (
                          <div key={i} className="flex items-center gap-3 border-b border-border py-2 last:border-0">
                            <DoseIcon status={d.status} />
                            <div>
                              <p className="text-lg font-semibold">{t("caregiver.dose.line", { name: d.medicationName, time: formatClock(d.time) })}</p>
                              <p className="text-muted-foreground">{DOSE_LABEL[d.status] ? t(DOSE_LABEL[d.status]) : d.status}</p>
                            </div>
                          </div>
                        ))}
                      </Section>
                    )}

                    {selected.permissions.appointments && overviewQuery.data.upcomingAppointments && (
                      <Section icon={CalendarDays} title={t("caregiver.comingUp")}>
                        {overviewQuery.data.upcomingAppointments.length === 0 && <p className="text-lg text-muted-foreground">{t("caregiver.noVisits")}</p>}
                        {overviewQuery.data.upcomingAppointments.map((a, i) => (
                          <div key={i} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 last:border-0">
                            <div>
                              <p className="text-lg font-semibold">{formatRelativeDay(a.scheduledAt)}</p>
                              <p className="text-muted-foreground">{t("health.apptWith", { type: APPT_TYPE[a.type] ? t(APPT_TYPE[a.type]) : a.type, doctor: a.doctorName })}</p>
                            </div>
                            <StatusBadge kind="appointment" status={a.status} />
                          </div>
                        ))}
                      </Section>
                    )}

                    {selected.permissions.deliveryStatus && overviewQuery.data.pharmacyOrders && overviewQuery.data.pharmacyOrders.length > 0 && (
                      <Section icon={Truck} title={t("circle.perm.delivery.label")} description={t("caregiver.pharmacy.desc")}>
                        {overviewQuery.data.pharmacyOrders.map((o, i) => (
                          <div key={i} className="flex flex-wrap items-center justify-between gap-2 py-1">
                            <p className="text-lg font-semibold">{o.medicationName}</p>
                            <StatusBadge kind="pharmacyOrder" status={o.status} />
                          </div>
                        ))}
                      </Section>
                    )}

                    {selected.permissions.documents && overviewQuery.data.documents && (
                      <Section icon={FileText} title={t("docs.title")}>
                        {overviewQuery.data.documents.length === 0 && <p className="text-lg text-muted-foreground">{t("caregiver.noDocs")}</p>}
                        {overviewQuery.data.documents.map((d, i) => (
                          <p key={i} className="text-lg">{d.title} <span className="text-muted-foreground">· {DOC_CATEGORY[d.category] ? t(DOC_CATEGORY[d.category]) : d.category}</span></p>
                        ))}
                      </Section>
                    )}

                    {!selected.permissions.medicationStatus && !selected.permissions.appointments && !selected.permissions.deliveryStatus && !selected.permissions.documents && (
                      <EmptyBlock title={t("caregiver.noneShared", { name: selected.patientName })} />
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
