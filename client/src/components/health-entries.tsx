import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/form-field";
import ConfirmAction from "@/components/confirm-action";
import { ReasonDialog } from "@/components/reason-dialog";
import QueryState from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate, formatDateTime } from "@/lib/format";

export type Kind = "allergy" | "medication" | "condition" | "procedure" | "provider" | "need";
export const ENTRY_KIND_ORDER: Kind[] = ["allergy", "medication", "condition", "procedure", "provider", "need"];

export interface Entry {
  id: string;
  kind: Kind;
  data: Record<string, string>;
  source: "patient_reported" | "clinician_entered";
  enteredBy: { role: "patient" | "doctor"; name: string | null };
  enteredAt: string;
  verified: { at: string; byName: string | null } | null;
  disputed: { at: string; note: string | null } | null;
  amended: boolean;
}

interface FieldDef { key: string; type: "text" | "textarea" | "severity"; required?: boolean }
const FIELDS: Record<Kind, FieldDef[]> = {
  allergy: [{ key: "substance", type: "text", required: true }, { key: "reaction", type: "text" }, { key: "severity", type: "severity" }, { key: "approximateDate", type: "text" }, { key: "notes", type: "textarea" }],
  medication: [{ key: "name", type: "text", required: true }, { key: "strength", type: "text" }, { key: "form", type: "text" }, { key: "instructions", type: "textarea" }, { key: "prescriber", type: "text" }, { key: "startDate", type: "text" }, { key: "endDate", type: "text" }, { key: "notes", type: "textarea" }],
  condition: [{ key: "name", type: "text", required: true }, { key: "since", type: "text" }, { key: "notes", type: "textarea" }],
  procedure: [{ key: "name", type: "text", required: true }, { key: "approximateDate", type: "text" }, { key: "notes", type: "textarea" }],
  provider: [{ key: "name", type: "text", required: true }, { key: "organization", type: "text" }, { key: "phone", type: "text" }, { key: "notes", type: "textarea" }],
  need: [{ key: "description", type: "textarea", required: true }],
};
const TITLE_KEY: Record<Kind, string> = { allergy: "substance", medication: "name", condition: "name", procedure: "name", provider: "name", need: "description" };

export type Mode = { who: "patient" } | { who: "doctor"; patientUserId: string };
const base = (m: Mode) => (m.who === "patient" ? "/api/health-profile" : `/api/assist/${m.patientUserId}`);

function Provenance({ e, mode }: { e: Entry; mode: Mode["who"] }) {
  const { t } = useI18n();
  const mine = mode === "patient";
  return (
    <div className="flex flex-wrap items-center gap-2 text-base">
      {e.source === "patient_reported" ? (
        <Badge variant="secondary">{t(mine ? "hp.prov.you" : "hp.prov.patient")}</Badge>
      ) : (
        <Badge variant="secondary">{e.enteredBy.name ? t("hp.prov.doctorNamed", { name: e.enteredBy.name }) : t("hp.prov.doctor")}</Badge>
      )}
      {e.verified ? (
        <Badge className="gap-1.5"><BadgeCheck className="h-4 w-4" aria-hidden="true" />{t("hp.prov.verified", { name: e.verified.byName ?? "", date: formatDate(e.verified.at) })}</Badge>
      ) : (
        <Badge variant="outline">{t("hp.prov.unverified")}</Badge>
      )}
      {e.amended && <Badge variant="outline">{t("hp.prov.amended")}</Badge>}
      {e.disputed && (
        <Badge variant="destructive" className="gap-1.5"><TriangleAlert className="h-4 w-4" aria-hidden="true" />{t(mine ? "hp.prov.disputedYou" : "hp.prov.disputedPatient", { note: e.disputed.note ?? "" })}</Badge>
      )}
    </div>
  );
}

function History({ id, mode }: { id: string; mode: Mode }) {
  const { t } = useI18n();
  const q = useQuery<{ action: string; at: string; by: string; name: string | null; note: string | null }[]>({ queryKey: [`${base(mode)}/entries/${id}/history`], enabled: mode.who === "patient", staleTime: 0 });
  return (
    <QueryState query={q} loadingLabel={t("hp.loading")}>
      {(rows) => (
        <ol className="space-y-1 text-base">
          {rows.map((r, i) => <li key={i}>{t("hp.history.item", { when: formatDateTime(r.at), what: t(`hp.history.${r.action}` as MessageKey), who: r.by === "doctor" ? (r.name ?? t("hp.prov.doctor")) : t("hp.prov.you") })}{r.note ? ` — ${r.note}` : ""}</li>)}
        </ol>
      )}
    </QueryState>
  );
}

function Row({ e, mode, onChanged }: { e: Entry; mode: Mode; onChanged: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const fields = FIELDS[e.kind].filter((f) => f.key !== TITLE_KEY[e.kind] && e.data[f.key]);
  const patient = mode.who === "patient";
  const canRemove = patient ? e.source === "patient_reported" && !e.verified : e.source === "clinician_entered";
  async function act(path: string, body?: unknown, done?: MessageKey) {
    try {
      await apiRequest("POST", `${base(mode)}/entries/${e.id}/${path}`, body);
      if (done) toast({ title: t(done) });
      onChanged();
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }
  if (editing) return <li className="rounded-2xl border-2 border-primary p-4"><EntryForm kind={e.kind} mode={mode} amend={e} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} /></li>;
  return (
    <li className="space-y-2 rounded-2xl border-2 border-input bg-card p-4">
      <p className="text-xl font-semibold">{e.data[TITLE_KEY[e.kind]]}{e.kind === "allergy" && e.data.severity && e.data.severity !== "unknown" ? ` · ${t(`hp.severity.${e.data.severity}` as MessageKey)}` : ""}</p>
      {fields.length > 0 && (
        <dl className="grid gap-x-6 gap-y-1 text-lg sm:grid-cols-2">
          {fields.filter((f) => !(e.kind === "allergy" && f.key === "severity")).map((f) => <div key={f.key}><dt className="text-base font-semibold text-muted-foreground">{t(`hp.f.${e.kind}.${f.key}` as MessageKey)}</dt><dd>{e.data[f.key]}</dd></div>)}
        </dl>
      )}
      <Provenance e={e} mode={mode.who} />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setEditing(true)}>{t("hp.edit")}<span className="sr-only">: {e.data[TITLE_KEY[e.kind]]}</span></Button>
        {mode.who === "doctor" && !e.verified && <Button onClick={() => act("verify", undefined, "hp.verified")}>{t("hp.verify")}<span className="sr-only">: {e.data[TITLE_KEY[e.kind]]}</span></Button>}
        {canRemove ? (
          <ConfirmAction
            trigger={<Button variant="outline">{t("hp.remove")}<span className="sr-only">: {e.data[TITLE_KEY[e.kind]]}</span></Button>}
            title={t("hp.remove.title")} description={t("hp.remove.body")} confirmLabel={t("hp.remove.yes")} cancelLabel={t("common.cancel")} destructive
            onConfirm={() => act("withdraw", undefined, "hp.removed")}
          />
        ) : patient ? (
          <ReasonDialog
            trigger={<Button variant="outline">{t("hp.dispute")}<span className="sr-only">: {e.data[TITLE_KEY[e.kind]]}</span></Button>}
            title={t("hp.dispute.title")} description={t("hp.dispute.body")} label={t("hp.dispute.label")} confirm={t("hp.dispute.send")} required
            onSubmit={(note) => act("dispute", { note }, "hp.disputed")}
          />
        ) : null}
        {patient && <Button variant="ghost" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>{t("hp.history.show")}<span className="sr-only">: {e.data[TITLE_KEY[e.kind]]}</span></Button>}
      </div>
      {showHistory && <History id={e.id} mode={mode} />}
    </li>
  );
}

export function EntryList({ kind, mode, onChanged, entries }: { kind: Kind; mode: "patient" | Mode; onChanged: () => void; entries?: Entry[] }) {
  const { t } = useI18n();
  const m: Mode = mode === "patient" ? { who: "patient" } : mode;
  const query = useQuery<Entry[]>({ queryKey: [`/api/health-profile/entries?kind=${kind}`], enabled: !entries && m.who === "patient", staleTime: 0 });
  const rows = (entries ?? query.data ?? []).filter((e) => e.kind === kind);
  if (!entries && m.who === "patient" && query.isLoading) return <p role="status">{t("hp.loading")}</p>;
  if (rows.length === 0) return <p className="rounded-xl border-2 border-dashed border-input p-4 text-lg text-muted-foreground">{t(`hp.empty.${kind}` as MessageKey)}</p>;
  return <ul className="space-y-3">{rows.map((e) => <Row key={e.id} e={e} mode={m} onChanged={onChanged} />)}</ul>;
}

export function EntryForm({ kind, mode, onSaved, amend, onCancel }: { kind: Kind; mode: "patient" | Mode; onSaved: () => void; amend?: Entry; onCancel?: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const m: Mode = mode === "patient" ? { who: "patient" } : mode;
  const [v, setV] = useState<Record<string, string>>(() => ({ ...(amend?.data ?? {}), ...(kind === "allergy" && !amend?.data.severity ? { severity: "unknown" } : {}) }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(!!amend);
  const title = t(`hp.add.${kind}` as MessageKey);
  if (!open) return <Button size="lg" variant="outline" onClick={() => setOpen(true)}>{title}</Button>;
  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const data: Record<string, string> = {};
    for (const f of FIELDS[kind]) if (v[f.key]?.trim()) data[f.key] = v[f.key].trim();
    try {
      if (amend) await apiRequest("POST", `${base(m)}/entries/${amend.id}/amend`, { data });
      else await apiRequest("POST", `${base(m)}/entries`, { kind, data });
      toast({ title: t("hp.saved") });
      setV({ ...(kind === "allergy" ? { severity: "unknown" } : {}) });
      if (!amend) setOpen(false);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border-2 border-input bg-card p-4" noValidate aria-label={amend ? t("hp.edit") : title}>
      <h3 className="text-xl font-semibold">{amend ? t("hp.edit") : title}</h3>
      {amend && <p className="text-base text-muted-foreground">{t("hp.amend.note")}</p>}
      {FIELDS[kind].map((f) => (
        <Field key={f.key} id={`f-${kind}-${f.key}`} label={t(`hp.f.${kind}.${f.key}` as MessageKey)} optional={!f.required}>
          {(a) =>
            f.type === "textarea" ? <Textarea {...a} rows={3} value={v[f.key] ?? ""} onChange={(e) => setV((p) => ({ ...p, [f.key]: e.target.value }))} />
            : f.type === "severity" ? (
              <NativeSelect {...a} value={v[f.key] ?? "unknown"} onChange={(e) => setV((p) => ({ ...p, [f.key]: e.target.value }))}>
                {["unknown", "mild", "moderate", "severe"].map((s) => <option key={s} value={s}>{t(`hp.severity.${s}` as MessageKey)}</option>)}
              </NativeSelect>
            ) : <Input {...a} value={v[f.key] ?? ""} onChange={(e) => setV((p) => ({ ...p, [f.key]: e.target.value }))} />
          }
        </Field>
      ))}
      {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={busy}>{busy ? t("common.saving") : t("common.save")}</Button>
        <Button type="button" size="lg" variant="outline" onClick={() => { if (onCancel) onCancel(); setOpen(false); }}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}

void formatDate;
