import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/status-badge";
import { formatRelativeDay } from "@/lib/format";

interface Appointment {
  id: string;
  pairingRequestId: string;
  type: string;
  reason: string;
  scheduledAt: string;
  status: string;
  patientName: string;
}

export default function DoctorAppointments() {
  const { data: appointments, isLoading } = useQuery<Appointment[]>({ queryKey: ["/api/appointments/doctor"] });

  const upcoming = (appointments || []).filter((a) => a.status === "requested" || a.status === "confirmed")
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const past = (appointments || []).filter((a) => a.status === "completed" || a.status === "cancelled");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Appointments</h1>
        <p className="text-sm text-muted-foreground">Confirm and complete visits from each patient's workspace.</p>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!isLoading && upcoming.length === 0 && <p className="text-sm text-muted-foreground">Nothing upcoming.</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {upcoming.map((a) => (
          <Card key={a.id}>
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle className="text-base">{a.patientName}</CardTitle>
                <CardDescription>{a.type} · {formatRelativeDay(a.scheduledAt)}</CardDescription>
              </div>
              <StatusBadge kind="appointment" status={a.status} />
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-2">
              <p className="line-clamp-1 text-sm text-muted-foreground">{a.reason}</p>
              <Link href={`/doctor/patients/${a.pairingRequestId}`}>
                <Button size="sm" variant="outline" className="gap-1">Open <ArrowRight className="h-3.5 w-3.5" /></Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>

      {past.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Past</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {past.map((a) => (
              <Card key={a.id} className="">
                <CardHeader className="flex flex-row items-start justify-between space-y-0">
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
