import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Pill, Stethoscope, CalendarDays, Truck, Siren, ChevronRight } from "lucide-react";
import { formatClock, formatRelativeDay } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { specialtyLabel } from "@/lib/labels";
import { appointmentTypeLabel } from "@/lib/labels";
import type { AuthUser } from "@/hooks/use-auth";

interface DashboardData {
  upcomingAppointment: { doctorName: string; type: string; scheduledAt: string } | null;
  nextMedicationReminder: { medicationName: string; time: string } | null;
  dosesRemainingToday: number;
  pharmacyStatus: { medicationName: string; status: string } | null;
}

interface Pairing {
  id: string;
  status: string;
  relationshipLabel: string | null;
  doctor: { name: string; specialty: string } | null;
}

// Order status wording for this screen. The four plain ones reuse the shared status labels.
const PHARMACY_STATUS_KEYS: Record<string, MessageKey> = {
  received: "pt.simple.pharm.received",
  processing: "pt.simple.pharm.processing",
  preparing: "pt.simple.pharm.preparing",
  ready_for_pickup: "status.pharmacyOrder.ready_for_pickup",
  out_for_delivery: "status.pharmacyOrder.out_for_delivery",
  delivered: "status.pharmacyOrder.delivered",
  picked_up: "status.pharmacyOrder.picked_up",
};

// A dramatically simplified home screen: five huge, unmistakable tiles,
// each carrying just the one fact that matters most right now. This is
// not a stripped-down Standard Mode — it's a deliberately different,
// calmer way to use the same product.
function BigTile({
  href,
  icon: Icon,
  label,
  detail,
  tone = "default",
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  detail: string;
  tone?: "default" | "urgent";
}) {
  return (
    <Link href={href}>
      <div
        className={`flex min-h-[112px] items-center gap-5 rounded-2xl border px-6 py-6 shadow-sm transition-transform active:scale-[0.99] ${
          tone === "urgent"
            ? "border-destructive/30 bg-destructive text-destructive-foreground"
            : "border-border bg-card text-card-foreground hover:border-primary/40"
        }`}
      >
        <span
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full ${
            tone === "urgent" ? "bg-white/15" : "bg-primary/10"
          }`}
        >
          <Icon className={`h-7 w-7 ${tone === "urgent" ? "text-white" : "text-primary"}`} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-semibold leading-tight">{label}</p>
          <p className={`mt-1 line-clamp-2 text-lg leading-snug ${tone === "urgent" ? "text-destructive-foreground/90" : "text-muted-foreground"}`}>{detail}</p>
        </div>
        <ChevronRight className={`h-7 w-7 shrink-0 ${tone === "urgent" ? "text-white/80" : "text-muted-foreground"} flip-rtl`} />
      </div>
    </Link>
  );
}

export default function SimpleHome({ user }: { user: AuthUser }) {
  const { t } = useI18n();
  const { data: dashboard } = useQuery<DashboardData>({ queryKey: ["/api/dashboard"] });
  const { data: pairings } = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });

  const pharmacyStatusLabel = (status: string) => (PHARMACY_STATUS_KEYS[status] ? t(PHARMACY_STATUS_KEYS[status]) : status);

  const primaryDoctor = (pairings || []).find(
    (p) => p.status === "accepted" && (p.relationshipLabel === "Primary Care" || !p.relationshipLabel),
  ) || (pairings || []).find((p) => p.status === "accepted");

  return (
    <div className="mx-auto max-w-xl space-y-8 py-4">
      <div>
        <p className="text-lg text-muted-foreground">{t("pt.simple.hello")}</p>
        <h1 className="text-4xl font-semibold tracking-tight">{user.name.split(" ")[0]}</h1>
      </div>

      <div className="space-y-4">
        <BigTile
          href="/medications"
          icon={Pill}
          label={t("pt.simple.medications")}
          detail={
            dashboard?.nextMedicationReminder
              ? t("pt.simple.medNext", { name: dashboard.nextMedicationReminder.medicationName, time: formatClock(dashboard.nextMedicationReminder.time) })
              : t("pt.simple.medNone")
          }
        />
        <BigTile
          href={primaryDoctor ? `/chat/${primaryDoctor.id}?with=${encodeURIComponent(primaryDoctor.doctor?.name ?? t("pt.yourDoctor"))}` : "/care-team"}
          icon={Stethoscope}
          label={t("pt.simple.doctor")}
          detail={primaryDoctor?.doctor ? t("pt.nameSpecialtyDot", { name: primaryDoctor.doctor.name, specialty: specialtyLabel(t, primaryDoctor.doctor.specialty) }) : t("pt.simple.doctorNone")}
        />
        <BigTile
          href="/appointments"
          icon={CalendarDays}
          label={t("pt.simple.appt")}
          detail={
            dashboard?.upcomingAppointment
              ? t("pt.simple.apptDetail", {
                  type: appointmentTypeLabel(t, dashboard.upcomingAppointment.type),
                  when: formatRelativeDay(dashboard.upcomingAppointment.scheduledAt),
                })
              : t("pt.simple.apptNone")
          }
        />
        <BigTile
          href="/pharmacy"
          icon={Truck}
          label={t("pt.simple.pharmacy")}
          detail={
            dashboard?.pharmacyStatus
              ? t("pt.simple.pharmDetail", {
                  name: dashboard.pharmacyStatus.medicationName,
                  status: pharmacyStatusLabel(dashboard.pharmacyStatus.status),
                })
              : t("pt.simple.pharmNone")
          }
        />
        <BigTile href="/sos" icon={Siren} label={t("pt.simple.sos")} detail={t("pt.simple.sosDetail")} tone="urgent" />
      </div>
    </div>
  );
}
