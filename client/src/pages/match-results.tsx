import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import DoctorCard, { type DoctorMatch } from "@/components/doctor-card";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";

export default function MatchResults({ reportId }: { reportId: string }) {
  const { toast } = useToast();
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());

  const { data: matches, isLoading } = useQuery<DoctorMatch[]>({
    queryKey: [`/api/symptom-reports/${reportId}/matches`],
  });

  async function handleRequest(doctorProfileId: string) {
    setRequestingId(doctorProfileId);
    try {
      await apiRequest("POST", "/api/pairings", { doctorProfileId, symptomReportId: reportId });
      setRequestedIds((prev) => new Set(prev).add(doctorProfileId));
      toast({ title: "Request sent", description: "We'll notify you when the doctor responds." });
    } catch (err: any) {
      toast({ title: "Couldn't send request", description: err.message, variant: "destructive" });
    } finally {
      setRequestingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Doctors near you</h1>
        <Link href="/pairings">
          <Button variant="outline" size="sm">
            My connections
          </Button>
        </Link>
      </div>
      {isLoading && <p className="text-muted-foreground">Finding doctors…</p>}
      {!isLoading && matches?.length === 0 && (
        <p className="text-muted-foreground">
          No matching doctors in your state yet. Try again later, or contact support.
        </p>
      )}
      <div className="space-y-4">
        {matches?.map((m) => (
          <DoctorCard
            key={m.doctorProfileId}
            match={m}
            onRequest={() => handleRequest(m.doctorProfileId)}
            requesting={requestingId === m.doctorProfileId}
            requested={requestedIds.has(m.doctorProfileId)}
          />
        ))}
      </div>
    </div>
  );
}
