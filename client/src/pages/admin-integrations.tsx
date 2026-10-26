import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/page-header";
import QueryState from "@/components/query-state";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, CircleDashed, Minus, TriangleAlert, CircleHelp } from "lucide-react";

type Status = "verified" | "configured_unverified" | "not_configured" | "unavailable" | "failed";
interface Integration { id: string; status: Status; facts: Record<string, number | string | null> }
interface Payload { integrations: Integration[]; emailLast7Days: Record<"accepted" | "delivered" | "delayed" | "bounced" | "complained" | "failed", number> }

// Never colour alone: each status has its own icon and its own words.
const ICON: Record<Status, typeof Check> = { verified: Check, configured_unverified: CircleHelp, not_configured: CircleDashed, unavailable: Minus, failed: TriangleAlert };
const TONE: Record<Status, string> = {
  verified: "border-primary/40 bg-secondary",
  configured_unverified: "border-ochre bg-sand text-sand-foreground",
  not_configured: "border-border bg-card",
  unavailable: "border-border bg-muted/40",
  failed: "border-destructive bg-destructive/10",
};

function factLines(t: ReturnType<typeof useI18n>["t"], i: Integration): string[] {
  const f = i.facts;
  const out: string[] = [];
  if (i.id === "email") out.push(t("int.fact.accepted", { count: Number(f.accepted) }), t("int.fact.delivered", { count: Number(f.delivered) }));
  if (i.id === "email_receipts") out.push(t("int.fact.eventsReceived", { count: Number(f.eventsReceived) }));
  if (i.id === "scheduler") {
    out.push(t("int.fact.callsLast24h", { count: Number(f.callsLast24h) }), t("int.fact.daysWithDependableCaller", { count: Number(f.daysWithDependableCaller), required: Number(f.daysRequired) }));
    if (f.lastSuccessAt) out.push(t("int.fact.lastSuccessAt", { value: formatDateTime(String(f.lastSuccessAt)) }));
  }
  return out;
}

export default function AdminIntegrations() {
  const { t } = useI18n();
  const query = useQuery<Payload>({ queryKey: ["/api/admin/integrations"], staleTime: 0 });
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t("int.title")} description={t("int.intro")} />
      <QueryState query={query} loadingLabel={t("admin.loading")}>
        {({ integrations, emailLast7Days }) => (
          <>
            <ul className="space-y-3">
              {integrations.map((i) => {
                const Icon = ICON[i.status];
                const lines = factLines(t, i);
                return (
                  <li key={i.id} className={`rounded-2xl border-2 p-4 ${TONE[i.status]}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="font-display text-xl">{t(`int.${i.id}.title` as MessageKey)}</h2>
                      <span className="inline-flex items-center gap-2 text-base font-semibold">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                        {t(`int.status.${i.status}` as MessageKey)}
                      </span>
                    </div>
                    <p className="mt-1 text-base text-muted-foreground">{t(`int.${i.id}.detail` as MessageKey)}</p>
                    {lines.length > 0 && (
                      <div className="mt-2">
                        <p className="text-sm font-semibold">{t("int.evidence")}</p>
                        <ul className="list-disc ps-5 text-base">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <Card>
              <CardHeader><CardTitle as="h2" className="font-display text-2xl">{t("int.email7.title")}</CardTitle></CardHeader>
              <CardContent>
                <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
                  {(["accepted", "delivered", "delayed", "bounced", "complained", "failed"] as const).map((k) => (
                    <div key={k}><dt className="text-base font-semibold text-muted-foreground">{t(`int.email7.${k}` as MessageKey)}</dt><dd className="text-lg">{emailLast7Days[k]}</dd></div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          </>
        )}
      </QueryState>
    </div>
  );
}
