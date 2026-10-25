import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CircleHelp, Clock, ShieldOff, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import ConfirmAction from "@/components/confirm-action";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { Ltr } from "@/components/ltr";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate } from "@/lib/format";
import { languageName, modalityLabel, roleLabel, specialtyLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

interface Application {
  id: string; name: string; displayName: string | null; email: string; professionalRole: string | null; specialty: string | null;
  licenseNumber: string | null; licensingBody: string | null; licensedStates: string[]; npiNumber: string | null; qualifications: string | null;
  languages: string[]; yearsExperience: number | null; clinic: string | null; modalities: string[]; phone: string | null; bio: string | null;
  status: string; infoRequest: string | null; reviewerNotes: string | null; submittedAt: string | null; createdAt: string;
}
interface Listing { filter: string; counts: Record<string, number>; applications: Application[] }

const FILTERS = ["open", "approved", "suspended", "rejected", "incomplete"] as const;
const STATUS_ICON: Record<string, typeof Clock> = { pending: Clock, needs_info: CircleHelp, approved: BadgeCheck, rejected: XCircle, suspended: ShieldOff, incomplete: Clock };

// Asks the reviewer for the words that will be sent to the applicant.
function ReasonDialog({ trigger, title, description, label, confirm, required, onSubmit }: {
  trigger: React.ReactNode; title: string; description: string; label: string; confirm: string; required?: boolean; onSubmit: (text: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await onSubmit(text.trim());
      setOpen(false);
      setText("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason-text" className="text-base">{label}</Label>
          <Textarea id="reason-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button disabled={busy || (required && text.trim().length < 5)} onClick={submit}>{confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApplicationCard({ a, onChanged }: { a: Application; onChanged: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  async function act(path: string, body: unknown, done: MessageKey) {
    try {
      await apiRequest("POST", `/api/admin/doctor-applications/${a.id}/${path}`, body);
      toast({ title: t(done) });
      onChanged();
    } catch (err: any) {
      toast({ title: t("admin.actionFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }
  const Icon = STATUS_ICON[a.status] ?? Clock;
  const rows: [string, React.ReactNode][] = [
    [t("onb.f.role"), a.professionalRole ? roleLabel(t, a.professionalRole) : "—"],
    [t("onb.f.specialty"), a.specialty ? specialtyLabel(t, a.specialty) : "—"],
    [t("onb.f.state"), a.licensedStates.join(", ") || "—"],
    [t("onb.f.license"), <Ltr key="l">{a.licenseNumber ?? "—"}</Ltr>],
    [t("onb.f.body"), a.licensingBody ?? "—"],
    [t("onb.f.npi"), <Ltr key="n">{a.npiNumber ?? "—"}</Ltr>],
    [t("onb.f.qualifications"), a.qualifications ?? "—"],
    [t("onb.f.languages"), a.languages.map(languageName).join(", ") || "—"],
    [t("onb.f.modalities"), a.modalities.map((m) => modalityLabel(t, m)).join(", ") || "—"],
    [t("onb.f.clinic"), a.clinic ?? "—"],
    [t("admin.contact"), <span key="c" className="flex flex-col"><Ltr>{a.email}</Ltr><Ltr>{a.phone ?? "—"}</Ltr></span>],
  ];
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle as="h2" className="font-display text-2xl">{a.displayName || a.name}</CardTitle>
          <CardDescription className="text-base">{t("admin.submitted", { date: formatDate(a.submittedAt ?? a.createdAt) })}</CardDescription>
        </div>
        <Badge variant={a.status === "approved" ? "default" : a.status === "rejected" || a.status === "suspended" ? "destructive" : "secondary"} className="gap-1.5">
          <Icon className="h-4 w-4" aria-hidden="true" />{t(`admin.status.${a.status}` as MessageKey)}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label}><dt className="text-base font-semibold text-muted-foreground">{label}</dt><dd className="text-base">{value}</dd></div>
          ))}
        </dl>
        {a.bio && <p className="text-base">{a.bio}</p>}
        {a.infoRequest && <p className="rounded-lg bg-sand p-3 text-sand-foreground"><strong>{t("admin.askedFor")}:</strong> {a.infoRequest}</p>}
        {a.reviewerNotes && <p className="rounded-lg bg-muted p-3"><strong>{t("onb.reason")}:</strong> {a.reviewerNotes}</p>}
        <p className="text-base text-muted-foreground">{t("admin.selfReported")}</p>
        <div className="flex flex-wrap gap-3">
          {a.status === "pending" && (
            <>
              <ConfirmAction
                trigger={<Button>{t("admin.approve")}<span className="sr-only">: {a.name}</span></Button>}
                title={t("admin.approve.title", { name: a.name })}
                description={t("admin.approve.body")}
                confirmLabel={t("admin.approve.yes")}
                cancelLabel={t("common.cancel")}
                onConfirm={() => act("approve", {}, "admin.approved")}
              />
              <ReasonDialog
                trigger={<Button variant="outline">{t("admin.askInfo")}<span className="sr-only">: {a.name}</span></Button>}
                title={t("admin.askInfo.title")} description={t("admin.askInfo.body")} label={t("admin.askInfo.label")} confirm={t("admin.askInfo.send")} required
                onSubmit={(message) => act("request-info", { message }, "admin.infoAsked")}
              />
            </>
          )}
          {(a.status === "pending" || a.status === "needs_info") && (
            <ReasonDialog
              trigger={<Button variant="outline">{t("admin.reject")}<span className="sr-only">: {a.name}</span></Button>}
              title={t("admin.reject.title")} description={t("admin.reject.body")} label={t("admin.reject.label")} confirm={t("admin.reject.confirm")}
              onSubmit={(reason) => act("reject", { reason: reason || undefined }, "admin.rejected")}
            />
          )}
          {a.status === "approved" && (
            <ReasonDialog
              trigger={<Button variant="outline">{t("admin.suspend")}<span className="sr-only">: {a.name}</span></Button>}
              title={t("admin.suspend.title")} description={t("admin.suspend.body")} label={t("admin.suspend.label")} confirm={t("admin.suspend.confirm")}
              onSubmit={(reason) => act("suspend", { reason: reason || undefined }, "admin.suspended")}
            />
          )}
          {a.status === "suspended" && (
            <ConfirmAction
              trigger={<Button>{t("admin.reinstate")}<span className="sr-only">: {a.name}</span></Button>}
              title={t("admin.reinstate.title", { name: a.name })} description={t("admin.reinstate.body")} confirmLabel={t("admin.reinstate.yes")} cancelLabel={t("common.cancel")}
              onConfirm={() => act("reinstate", {}, "admin.reinstated")}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminDashboard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("open");
  const query = useQuery<Listing>({ queryKey: [`/api/admin/doctor-applications?status=${filter}`] });
  const counts = query.data?.counts ?? {};
  const countFor = (f: string) => (f === "open" ? (counts.pending ?? 0) + (counts.needs_info ?? 0) : counts[f] ?? 0);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t("nav.admin")} description={t("admin.intro")} />
      <div role="radiogroup" aria-label={t("admin.filter")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}
            className={cn("min-h-11 rounded-full border-2 px-4 text-base font-semibold", filter === f ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-secondary")}
          >
            {t(`admin.filter.${f}` as MessageKey)} ({countFor(f)})
          </button>
        ))}
      </div>
      <QueryState query={query} loadingLabel={t("admin.loading")} isEmpty={(d) => d.applications.length === 0} empty={<EmptyBlock title={t("admin.empty")} />}>
        {(data) => (
          <ul className="space-y-5">
            {data.applications.map((a) => (
              <li key={a.id}>
                <ApplicationCard a={a} onChanged={() => queryClient.invalidateQueries({ queryKey: [`/api/admin/doctor-applications?status=${filter}`] }).then(() => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/") }))} />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
