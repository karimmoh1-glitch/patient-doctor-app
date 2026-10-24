import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/status-badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";

interface DoctorPairing {
  id: string;
  status: string;
  requestedAt: string;
  patientName: string;
  symptomReportId: string | null;
}

export default function DoctorRequests() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [symptomText, setSymptomText] = useState<Record<string, string>>({});
  const [respondingId, setRespondingId] = useState<string | null>(null);

  const { data: requests, isLoading } = useQuery<DoctorPairing[]>({ queryKey: ["/api/pairings/doctor"] });

  async function toggleSymptomReport(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!symptomText[id]) {
      try {
        const res = await apiRequest("GET", `/api/pairings/${id}/symptom-report`);
        const data = await res.json();
        setSymptomText((prev) => ({ ...prev, [id]: data.symptomText }));
      } catch {
        setSymptomText((prev) => ({ ...prev, [id]: "No symptom report attached." }));
      }
    }
  }

  async function respond(id: string, action: "accept" | "decline") {
    setRespondingId(id);
    try {
      await apiRequest("PATCH", `/api/pairings/${id}/${action}`);
      queryClient.invalidateQueries({ queryKey: ["/api/pairings/doctor"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/doctor"] });
    } catch (err: any) {
      toast({ title: "Couldn't respond", description: err.message, variant: "destructive" });
    } finally {
      setRespondingId(null);
    }
  }

  const pending = (requests || []).filter((r) => r.status === "requested");
  const resolved = (requests || []).filter((r) => r.status !== "requested");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Connection requests</h1>
        <p className="text-sm text-muted-foreground">Patients asking to connect with you.</p>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!isLoading && pending.length === 0 && <p className="text-sm text-muted-foreground">No pending requests.</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {pending.map((r) => (
          <Card key={r.id}>
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle>{r.patientName}</CardTitle>
                <CardDescription>Requested {formatDate(r.requestedAt)}</CardDescription>
              </div>
              <StatusBadge kind="pairing" status={r.status} />
            </CardHeader>
            <CardContent className="space-y-3">
              {r.symptomReportId && (
                <Button variant="outline" size="sm" onClick={() => toggleSymptomReport(r.id)}>
                  {expandedId === r.id ? "Hide symptoms" : "View symptoms"}
                </Button>
              )}
              {expandedId === r.id && (
                <p className="rounded-md border border-border bg-muted p-3 text-sm">{symptomText[r.id]}</p>
              )}
              <div className="flex gap-2">
                <Button size="sm" disabled={respondingId === r.id} onClick={() => respond(r.id, "accept")}>Accept</Button>
                <Button size="sm" variant="outline" disabled={respondingId === r.id} onClick={() => respond(r.id, "decline")}>Decline</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {resolved.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Past requests</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {resolved.map((r) => (
              <Card key={r.id} className="">
                <CardHeader className="flex flex-row items-start justify-between space-y-0">
                  <CardTitle className="text-base">{r.patientName}</CardTitle>
                  <StatusBadge kind="pairing" status={r.status} />
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
