import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarDays, Inbox, Users, ClipboardCheck, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import { greeting } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";
import type { AuthUser } from "@/hooks/use-auth";

interface DoctorDashboard {
  todaysAppointments: { id: string; type: string; scheduledAt: string; patientName: string; status: string }[];
  pendingConnectionRequests: number;
  pendingAppointmentConfirmations: number;
  activePatients: number;
  activePrescriptionsWritten: number;
}

const TYPE_KEYS: Record<string, MessageKey> = {
  "Video Visit": "appttype.video_visit",
  "Phone Call": "appttype.phone_call",
  "In-Person": "appttype.in_person",
};

export default function DoctorHome({ user }: { user: AuthUser }) {
  const { t } = useI18n();
  const { data, isLoading } = useQuery<DoctorDashboard>({ queryKey: ["/api/dashboard/doctor"] });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("dhome.greeting", { greeting: greeting(), name: user.name.split(" ").pop() ?? "" })}</h1>
        <p className="text-sm text-muted-foreground">{t("dhome.subtitle")}</p>
      </div>

      {isLoading && <p className="text-muted-foreground">{t("common.loading")}</p>}

      {data && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><Inbox className="h-4 w-4" /> {t("dhome.pending")}</CardTitle></CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{data.pendingConnectionRequests}</p>
              <Link href="/doctor/requests"><Button variant="ghost" size="sm" className="-ms-3 gap-1 text-primary">{t("dhome.review")} <ArrowRight className="h-3.5 w-3.5 flip-rtl" /></Button></Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><Users className="h-4 w-4" /> {t("dhome.activePatients")}</CardTitle></CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{data.activePatients}</p>
              <Link href="/doctor/patients"><Button variant="ghost" size="sm" className="-ms-3 gap-1 text-primary">{t("dhome.view")} <ArrowRight className="h-3.5 w-3.5 flip-rtl" /></Button></Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><ClipboardCheck className="h-4 w-4" /> {t("dhome.rxActive")}</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-semibold">{data.activePrescriptionsWritten}</p></CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="h-4 w-4 text-primary" /> {t("dhome.today")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(data?.todaysAppointments.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">{t("dhome.nothing")}</p>}
          {data?.todaysAppointments.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
              <div className="min-w-0">
                <p className="text-sm font-medium">{a.patientName}</p>
                <p className="text-xs text-muted-foreground">{TYPE_KEYS[a.type] ? t(TYPE_KEYS[a.type]) : a.type} · {formatTime(a.scheduledAt)}</p>
              </div>
              <Link href="/doctor/appointments"><Button size="sm" variant="outline">{t("dhome.manage")}</Button></Link>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
