import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { EntryList, EntryForm, ENTRY_KIND_ORDER, type Entry } from "@/components/health-entries";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate } from "@/lib/format";

interface Assisting { id: string; patientUserId: string; name: string; expiresAt: string }
interface Profile {
  patient: { name: string; language: string };
  allergy: { picture: "not_collected" | "has_known" | "none_known" | "unknown"; statedBy: "patient" | "doctor" | null; statedAt: string | null; clinicianReviewedAt: string | null };
  entries: Entry[];
}

function List() {
  const { t } = useI18n();
  const query = useQuery<Assisting[]>({ queryKey: ["/api/assist/patients"], staleTime: 0 });
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t("hp.doc.title")} description={t("hp.doc.intro")} />
      <QueryState query={query} loadingLabel={t("hp.loading")} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title={t("hp.doc.empty")} />}>
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/doctor/assist/${r.patientUserId}`} className="flex min-h-16 items-center justify-between gap-3 rounded-2xl border-2 border-input bg-card p-4 hover:border-primary">
                  <span className="text-xl font-semibold">{r.name}</span>
                  <span className="text-base text-muted-foreground">{t("hp.assist.until", { date: formatDate(r.expiresAt) })}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

function PatientProfile({ patientUserId }: { patientUserId: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const key = `/api/assist/${patientUserId}`;
  const query = useQuery<Profile>({ queryKey: [key], staleTime: 0 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: [key] });
  async function allergy(path: string, body?: unknown, method: "PUT" | "POST" = "PUT") {
    try {
      await apiRequest(method, `${key}/allergies/${path}`, body);
      toast({ title: t("hp.saved") });
      refresh();
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
    }
  }
  const mode = { who: "doctor" as const, patientUserId };
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="outline"><Link href="/doctor/assist"><ArrowLeft aria-hidden="true" className="flip-rtl" /> {t("hp.doc.back")}</Link></Button>
      <QueryState query={query} loadingLabel={t("hp.loading")}>
        {(p) => (
          <>
            <PageHeader title={t("hp.doc.profileOf", { name: p.patient.name })} description={t("hp.doc.profileNote")} />
            <section aria-labelledby="doc-allergy" className="space-y-3 rounded-2xl border-2 border-input bg-card p-4">
              <h2 id="doc-allergy" className="font-display text-2xl">{t("hp.sec.allergies")}</h2>
              <p role="status" className="text-xl font-semibold">{t(`hp.doc.allergy.${p.allergy.picture}` as MessageKey)}</p>
              {p.allergy.statedAt && p.allergy.picture !== "has_known" && <p className="text-base text-muted-foreground">{t(p.allergy.statedBy === "doctor" ? "hp.doc.statedByDoctor" : "hp.doc.statedByPatient", { date: formatDate(p.allergy.statedAt) })}</p>}
              {p.allergy.clinicianReviewedAt && <p className="text-base text-muted-foreground">{t("hp.allergy.reviewed", { date: formatDate(p.allergy.clinicianReviewedAt) })}</p>}
              <EntryList kind="allergy" mode={mode} entries={p.entries} onChanged={refresh} />
              <EntryForm kind="allergy" mode={mode} onSaved={refresh} />
              <div className="flex flex-wrap gap-3">
                {p.allergy.picture !== "has_known" && <Button variant="outline" onClick={() => allergy("statement", { state: "none_known" })}>{t("hp.doc.confirmNone")}</Button>}
                {p.allergy.picture !== "has_known" && <Button variant="outline" onClick={() => allergy("statement", { state: "unknown" })}>{t("hp.doc.markUnknown")}</Button>}
                {p.allergy.picture !== "not_collected" && <Button onClick={() => allergy("review", undefined, "POST")}>{t("hp.doc.markReviewed")}</Button>}
              </div>
            </section>
            {ENTRY_KIND_ORDER.filter((k) => k !== "allergy").map((k) => (
              <section key={k} aria-labelledby={`doc-${k}`} className="space-y-3">
                <h2 id={`doc-${k}`} className="font-display text-2xl">{t(`hp.kind.${k}.plural` as MessageKey)}</h2>
                <EntryList kind={k} mode={mode} entries={p.entries} onChanged={refresh} />
                <EntryForm kind={k} mode={mode} onSaved={refresh} />
              </section>
            ))}
          </>
        )}
      </QueryState>
    </div>
  );
}

export default function DoctorAssist({ patientUserId }: { patientUserId?: string }) {
  return patientUserId ? <PatientProfile patientUserId={patientUserId} /> : <List />;
}
