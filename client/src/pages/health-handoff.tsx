import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HeartHandshake, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDate, formatRelativeDay } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";

interface Medication { id: string; name: string; instructions: string; active: boolean }
interface Appointment { id: string; type: string; scheduledAt: string; status: string; doctor: { name: string } | null }
interface Prescription { id: string; medicationName: string; instructions: string; status: string }
interface Document { id: string; title: string; category: string; createdAt: string }
interface Pairing { id: string; status: string; doctor: { name: string } | null }
interface CareCircleMember { id: string; name: string; status: string }

// `apiLabel` is what the audit trail records (kept in English); `labelKey` is what the reader sees.
const CATEGORIES = [
  { key: "medications", apiLabel: "Current medications", labelKey: "handoff.cat.medications" },
  { key: "appointments", apiLabel: "Recent & upcoming appointments", labelKey: "handoff.cat.appointments" },
  { key: "prescriptions", apiLabel: "Prescriptions", labelKey: "health.prescriptions" },
  { key: "documents", apiLabel: "Documents", labelKey: "docs.title" },
] as const satisfies readonly { key: string; apiLabel: string; labelKey: MessageKey }[];

// Stored values stay as the server keeps them; only what the reader sees is translated.
const DOC_CATEGORY: Record<string, MessageKey> = {
  "Lab Result": "docs.category.lab_result",
  Imaging: "docs.category.imaging",
  "Visit Summary": "docs.category.visit_summary",
  Insurance: "docs.category.insurance",
  Other: "docs.category.other",
};
const APPT_TYPE: Record<string, MessageKey> = {
  "Video Visit": "health.apptType.video",
  "Phone Call": "health.apptType.phone",
  "In-Person": "health.apptType.inPerson",
};
const STATUS_WORD: Record<string, MessageKey> = {
  requested: "handoff.status.requested",
  confirmed: "handoff.status.confirmed",
  completed: "handoff.status.completed",
  cancelled: "handoff.status.cancelled",
  draft: "handoff.status.draft",
  active: "handoff.status.active",
  expired: "handoff.status.expired",
};

type CategoryKey = (typeof CATEGORIES)[number]["key"];

export default function HealthHandoff() {
  const { toast } = useToast();
  const { t } = useI18n();
  const typeLabel = (v: string) => (APPT_TYPE[v] ? t(APPT_TYPE[v]) : v);
  const statusLabel = (v: string) => (STATUS_WORD[v] ? t(STATUS_WORD[v]) : v);
  const categoryLabel = (v: string) => (DOC_CATEGORY[v] ? t(DOC_CATEGORY[v]) : v);
  const [selected, setSelected] = useState<Record<CategoryKey, boolean>>({
    medications: true, appointments: true, prescriptions: true, documents: false,
  });
  const [recipient, setRecipient] = useState<string>("");
  const [sharing, setSharing] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const { data: medications } = useQuery<Medication[]>({ queryKey: ["/api/medications"] });
  const { data: appointments } = useQuery<Appointment[]>({ queryKey: ["/api/appointments"] });
  const { data: prescriptions } = useQuery<Prescription[]>({ queryKey: ["/api/prescriptions"] });
  const { data: documents } = useQuery<Document[]>({ queryKey: ["/api/documents"] });
  const { data: pairings } = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });
  const { data: careCircle } = useQuery<CareCircleMember[]>({ queryKey: ["/api/care-circle"] });

  const recipients = [
    ...(pairings || []).filter((p) => p.status === "accepted").map((p) => ({ id: `doctor:${p.id}`, label: p.doctor?.name || t("handoff.recipient.doctor") })),
    ...(careCircle || []).filter((m) => m.status === "active").map((m) => ({ id: `caregiver:${m.id}`, label: m.name })),
  ];

  async function share() {
    if (!recipient) {
      toast({ title: t("handoff.toast.chooseRecipient"), variant: "destructive" });
      return;
    }
    const categories = CATEGORIES.filter((c) => selected[c.key]).map((c) => c.apiLabel);
    if (categories.length === 0) {
      toast({ title: t("handoff.toast.chooseCategory"), variant: "destructive" });
      return;
    }
    setSharing(true);
    try {
      const recipientLabel = recipients.find((r) => r.id === recipient)?.label || "recipient";
      const res = await apiRequest("POST", "/api/health-summary/share", { recipientLabel, categories });
      const data = await res.json();
      toast({ title: t("handoff.toast.shared"), description: data.message });
    } catch (err: any) {
      toast({ title: t("handoff.toast.failed"), description: err.message, variant: "destructive" });
    } finally {
      setSharing(false);
    }
  }

  if (reviewing) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold"><HeartHandshake className="h-5 w-5 text-primary" aria-hidden="true" /> {t("handoff.review.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("handoff.review.intro")}</p>
        </div>

        <Card>
          <CardContent className="space-y-5 p-6">
            {selected.medications && (
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("handoff.cat.medications")}</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {(medications || []).filter((m) => m.active).map((m) => <li key={m.id}>{t("handoff.line.med", { name: m.name, instructions: m.instructions })}</li>)}
                  {(medications || []).filter((m) => m.active).length === 0 && <li className="text-muted-foreground">{t("handoff.none.active")}</li>}
                </ul>
              </div>
            )}
            {selected.appointments && (
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("handoff.sec.appointments")}</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {(appointments || []).slice(0, 5).map((a) => <li key={a.id}>{t("handoff.line.appt", { type: typeLabel(a.type), doctor: a.doctor?.name ?? "", when: formatRelativeDay(a.scheduledAt), status: statusLabel(a.status) })}</li>)}
                  {(appointments || []).length === 0 && <li className="text-muted-foreground">{t("handoff.none.recorded")}</li>}
                </ul>
              </div>
            )}
            {selected.prescriptions && (
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("health.prescriptions")}</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {(prescriptions || []).map((p) => <li key={p.id}>{t("handoff.line.rx", { name: p.medicationName, instructions: p.instructions, status: statusLabel(p.status) })}</li>)}
                  {(prescriptions || []).length === 0 && <li className="text-muted-foreground">{t("handoff.none.recorded")}</li>}
                </ul>
              </div>
            )}
            {selected.documents && (
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("docs.title")}</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {(documents || []).map((d) => <li key={d.id}>{t("handoff.line.doc", { title: d.title, category: categoryLabel(d.category), date: formatDate(d.createdAt) })}</li>)}
                  {(documents || []).length === 0 && <li className="text-muted-foreground">{t("handoff.none.uploaded")}</li>}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          <Select value={recipient} onValueChange={setRecipient}>
            <SelectTrigger><SelectValue placeholder={t("handoff.shareWith")} /></SelectTrigger>
            <SelectContent>
              {recipients.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setReviewing(false)}>{t("common.back")}</Button>
            <Button disabled={sharing} onClick={share} className="gap-1"><Send className="h-4 w-4 flip-rtl" aria-hidden="true" /> {t("handoff.share")}</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><HeartHandshake className="h-5 w-5 text-primary" aria-hidden="true" /> {t("handoff.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("handoff.intro")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("handoff.include")}</CardTitle>
          <CardDescription>{t("handoff.includeHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {CATEGORIES.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm">
              <Checkbox checked={selected[c.key]} onCheckedChange={(checked) => setSelected((s) => ({ ...s, [c.key]: checked === true }))} />
              {t(c.labelKey)}
            </label>
          ))}
        </CardContent>
      </Card>

      <Button onClick={() => setReviewing(true)}>{t("handoff.reviewButton")}</Button>
    </div>
  );
}
