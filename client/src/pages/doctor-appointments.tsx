import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/status-badge";
import { formatRelativeDay } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";

interface Appointment {
  id: string;
  pairingRequestId: string;
  type: string;
  reason: string;
  scheduledAt: string;
  status: string;
  patientName: string;
}

const TYPE_KEYS: Record<string, MessageKey> = {
  "Video Visit": "appttype.video_visit",
  "Phone Call": "appttype.phone_call",
  "In-Person": "appttype.in_person",
};

export default function DoctorAppointments() {
  const { t } = useI18n();
  const { data: appointments, isLoading } = useQuery<Appointment[]>({ queryKey: ["/api/appointments/doctor"] });

  const upcoming = (appointments || []).filter((a) => a.status === "requested" || a.status === "confirmed")
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const past = (appointments || []).filter((a) => a.status === "completed" || a.status === "cancelled");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{t("nav.d.appointments")}</h1>
        <p className="text-sm text-muted-foreground">{t("dappt.subtitle")}</p>
      </div>

      {isLoading && <p className="text-muted-foreground">{t("common.loading")}</p>}
      {!isLoading && upcoming.length === 0 && <p className="text-sm text-muted-foreground">{t("dappt.none")}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {upcoming.map((a) => (
          <Card key={a.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div className="min-w-0">
                <CardTitle className="text-base">{a.patientName}</CardTitle>
                <CardDescription>{TYPE_KEYS[a.type] ? t(TYPE_KEYS[a.type]) : a.type} · {formatRelativeDay(a.scheduledAt)}</CardDescription>
              </div>
              <StatusBadge kind="appointment" status={a.status} />
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-2">
              <p className="line-clamp-1 min-w-0 text-sm text-muted-foreground">{a.reason}</p>
              <Link href={`/doctor/patients/${a.pairingRequestId}`}>
                <Button size="sm" variant="outline" className="gap-1">{t("dpat.open")} <ArrowRight className="h-3.5 w-3.5 flip-rtl" /></Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>

      {past.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{t("dappt.past")}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {past.map((a) => (
              <Card key={a.id} className="">
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <CardTitle className="text-base">{a.patientName}</CardTitle>
                  <StatusBadge kind="appointment" status={a.status} />
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
