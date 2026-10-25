import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import DoctorCard, { type DoctorMatch } from "@/components/doctor-card";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { EmptyBlock, LoadingBlock } from "@/components/query-state";
import { useI18n } from "@/lib/i18n";

export default function MatchResults({ reportId }: { reportId: string }) {
  const { t } = useI18n();
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
      toast({ title: t("pt.requestSent"), description: t("pt.match.sentBody") });
    } catch (err: any) {
      toast({ title: t("pt.match.sendFail"), description: err.message, variant: "destructive" });
    } finally {
      setRequestingId(null);
    }
  }

  // The link sits inside the sentence, so its position comes from the translation.
  const [emptyBefore, emptyAfter] = t("pt.match.emptyBody").split("{link}");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold">{t("pt.match.title")}</h1>
        <Button asChild variant="outline"><Link href="/care-team">{t("pt.myDoctors")}</Link></Button>
      </div>
      <p className="text-lg text-muted-foreground">
        {t("pt.match.intro")}
      </p>
      {isLoading && <LoadingBlock label={t("pt.match.finding")} />}
      {!isLoading && matches?.length === 0 && (
        <EmptyBlock title={t("pt.match.emptyTitle")}>
          {emptyBefore}<Link href="/help" className="font-medium text-primary underline">{t("pt.match.emptyLink")}</Link>{emptyAfter}
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
