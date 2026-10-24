import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Pill, Stethoscope, CalendarDays, Truck, Siren, ChevronRight } from "lucide-react";
import { formatRelativeDay } from "@/lib/format";
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

function PHARMACY_STATUS_LABEL(status: string): string {
  const labels: Record<string, string> = {
    received: "Order received",
    processing: "Being processed",
    preparing: "Being prepared",
    ready_for_pickup: "Ready for pickup",
    out_for_delivery: "Out for delivery",
    delivered: "Delivered",
    picked_up: "Picked up",
  };
  return labels[status] || status;
}

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
        <ChevronRight className={`h-7 w-7 shrink-0 ${tone === "urgent" ? "text-white/80" : "text-muted-foreground"}`} />
      </div>
    </Link>
  );
}

export default function SimpleHome({ user }: { user: AuthUser }) {
  const { data: dashboard } = useQuery<DashboardData>({ queryKey: ["/api/dashboard"] });
  const { data: pairings } = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });

  const primaryDoctor = (pairings || []).find(
    (p) => p.status === "accepted" && (p.relationshipLabel === "Primary Care" || !p.relationshipLabel),
  ) || (pairings || []).find((p) => p.status === "accepted");

  return (
    <div className="mx-auto max-w-xl space-y-8 py-4">
      <div>
        <p className="text-lg text-muted-foreground">Hello,</p>
        <h1 className="text-4xl font-semibold tracking-tight">{user.name.split(" ")[0]}</h1>
      </div>

      <div className="space-y-4">
        <BigTile
          href="/medications"
          icon={Pill}
          label="Medications"
          detail={
            dashboard?.nextMedicationReminder
              ? `Next: ${dashboard.nextMedicationReminder.medicationName} at ${dashboard.nextMedicationReminder.time}`
              : "Nothing due right now"
          }
        />
        <BigTile
          href={primaryDoctor ? `/chat/${primaryDoctor.id}?with=${encodeURIComponent(primaryDoctor.doctor?.name ?? "your doctor")}` : "/care-team"}
          icon={Stethoscope}
          label="My Doctor"
          detail={primaryDoctor?.doctor ? `${primaryDoctor.doctor.name} · ${primaryDoctor.doctor.specialty}` : "No doctor connected yet"}
        />
        <BigTile
          href="/appointments"
          icon={CalendarDays}
          label="Appointment"
          detail={
            dashboard?.upcomingAppointment
              ? `${dashboard.upcomingAppointment.type} · ${formatRelativeDay(dashboard.upcomingAppointment.scheduledAt)}`
              : "Nothing scheduled"
          }
        />
        <BigTile
          href="/pharmacy"
          icon={Truck}
          label="Pharmacy"
          detail={dashboard?.pharmacyStatus ? `${dashboard.pharmacyStatus.medicationName} — ${PHARMACY_STATUS_LABEL(dashboard.pharmacyStatus.status)}` : "No active orders"}
        />
        <BigTile href="/sos" icon={Siren} label="SOS" detail="Get help fast" tone="urgent" />
      </div>
    </div>
  );
}
