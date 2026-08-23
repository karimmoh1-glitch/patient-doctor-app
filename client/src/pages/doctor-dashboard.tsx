import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { MessageCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import PairingStatusBadge from "@/components/pairing-status-badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface DoctorPairing {
  id: string;
  status: string;
  requestedAt: string;
  patientName: string;
  symptomReportId: string | null;
}

export default function DoctorDashboard() {
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
    } catch (err: any) {
      toast({ title: "Couldn't respond", description: err.message, variant: "destructive" });
    } finally {
      setRespondingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Connection requests</h1>
      {isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!isLoading && requests?.length === 0 && <p className="text-muted-foreground">No requests yet.</p>}
      <div className="space-y-4">
        {requests?.map((r) => (
          <Card key={r.id}>
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle>{r.patientName}</CardTitle>
                <CardDescription>Requested {new Date(r.requestedAt).toLocaleDateString()}</CardDescription>
              </div>
              <PairingStatusBadge status={r.status} />
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
              {r.status === "requested" && (
                <div className="flex gap-2">
                  <Button size="sm" disabled={respondingId === r.id} onClick={() => respond(r.id, "accept")}>
                    Accept
                  </Button>
                  <Button size="sm" variant="outline" disabled={respondingId === r.id} onClick={() => respond(r.id, "decline")}>
                    Decline
                  </Button>
                </div>
              )}
              {r.status === "accepted" && (
                <Link href={`/chat/${r.id}?with=${encodeURIComponent(r.patientName)}`}>
                  <Button size="sm" variant="outline">
                    <MessageCircle /> Message {r.patientName}
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
