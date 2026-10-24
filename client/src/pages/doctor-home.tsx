import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarDays, Inbox, Users, ClipboardCheck, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import { greeting } from "@/lib/format";
import type { AuthUser } from "@/hooks/use-auth";

interface DoctorDashboard {
  todaysAppointments: { id: string; type: string; scheduledAt: string; patientName: string; status: string }[];
  pendingConnectionRequests: number;
  pendingAppointmentConfirmations: number;
  activePatients: number;
  activePrescriptionsWritten: number;
}

export default function DoctorHome({ user }: { user: AuthUser }) {
  const { data, isLoading } = useQuery<DoctorDashboard>({ queryKey: ["/api/dashboard/doctor"] });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{greeting()}, Dr. {user.name.split(" ").pop()}.</h1>
        <p className="text-sm text-muted-foreground">Here's your practice today.</p>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading…</p>}

      {data && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><Inbox className="h-4 w-4" /> Pending requests</CardTitle></CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{data.pendingConnectionRequests}</p>
              <Link href="/doctor/requests"><Button variant="ghost" size="sm" className="-ml-3 gap-1 text-primary">Review <ArrowRight className="h-3.5 w-3.5" /></Button></Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><Users className="h-4 w-4" /> Active patients</CardTitle></CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{data.activePatients}</p>
              <Link href="/doctor/patients"><Button variant="ghost" size="sm" className="-ml-3 gap-1 text-primary">View <ArrowRight className="h-3.5 w-3.5" /></Button></Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><ClipboardCheck className="h-4 w-4" /> Prescriptions active</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-semibold">{data.activePrescriptionsWritten}</p></CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="h-4 w-4 text-primary" /> Today's appointments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(data?.todaysAppointments.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">Nothing scheduled today.</p>}
          {data?.todaysAppointments.map((a) => (
            <div key={a.id} className="flex items-center justify-between border-b border-border py-2 last:border-0">
              <div>
                <p className="text-sm font-medium">{a.patientName}</p>
                <p className="text-xs text-muted-foreground">{a.type} · {formatTime(a.scheduledAt)}</p>
              </div>
              <Link href="/doctor/appointments"><Button size="sm" variant="outline">Manage</Button></Link>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
