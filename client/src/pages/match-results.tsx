import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import DoctorCard, { type DoctorMatch } from "@/components/doctor-card";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { EmptyBlock, LoadingBlock } from "@/components/query-state";

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold">Doctors in your state</h1>
        <Button asChild variant="outline"><Link href="/care-team">My doctors</Link></Button>
      </div>
      <p className="text-lg text-muted-foreground">
        These doctors are licensed in your state. Those whose speciality fits what you wrote are first. We have not checked your symptoms — this is only a suggestion.
      </p>
      {isLoading && <LoadingBlock label="Finding doctors" />}
      {!isLoading && matches?.length === 0 && (
        <EmptyBlock title="No doctors are available in your state yet">
          We can't promise when one will be. You can <Link href="/help" className="font-medium text-primary underline">ask for help here</Link>.
        </EmptyBlock>
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
