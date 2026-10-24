import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface DoctorPairing {
  id: string;
  status: string;
  patientUserId: string;
  patientName: string;
}

export default function DoctorPatients() {
  const { data: requests, isLoading } = useQuery<DoctorPairing[]>({ queryKey: ["/api/pairings/doctor"] });
  const patients = (requests || []).filter((r) => r.status === "accepted");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Patients</h1>
        <p className="text-sm text-muted-foreground">Everyone you're connected with.</p>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!isLoading && patients.length === 0 && <p className="text-sm text-muted-foreground">No connected patients yet — accept a request to get started.</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {patients.map((p) => (
          <Card key={p.id}>
            <CardHeader>
              <CardTitle className="text-base">{p.patientName}</CardTitle>
            </CardHeader>
            <CardContent>
              <Link href={`/doctor/patients/${p.id}`}>
                <Button size="sm" variant="outline" className="gap-1">Open <ArrowRight className="h-3.5 w-3.5" /></Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
