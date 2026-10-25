import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/form-field";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";

export interface PrescriptionRecord {
  id: string;
  pairingRequestId: string;
  medicationName: string;
  activeIngredient: string | null;
  strength: string | null;
  formulation: string | null;
  dose: string | null;
  route: string | null;
  frequencyPerDay: number;
  durationDays: number | null;
  quantity: number | null;
  refillsAllowed: number;
  instructions: string;
  warnings: string | null;
  notes: string | null;
  status: string;
  authorizedAt: string | null;
  transmission: string;
}

const ROUTES = ["oral", "topical", "inhaled", "nasal", "ophthalmic", "otic", "rectal", "subcutaneous", "intramuscular", "other"] as const;

const empty = {
  medicationName: "", activeIngredient: "", strength: "", formulation: "", dose: "", route: "oral", frequencyPerDay: "1",
  durationDays: "", quantity: "", refillsAllowed: "0", instructions: "", warnings: "", notes: "", controlled: "no",
};

/**
 * Writes or edits a DRAFT prescription. A draft is the doctor's working copy:
 * the patient can't see it until the doctor reviews and authorizes it
 * separately. Avela doesn't check doses or interactions and doesn't send
 * anything to a pharmacy, and the form says so.
 */
export default function PrescriptionDialog({
  pairingId, existing, onDone, trigger,
}: {
  pairingId: string;
  existing?: PrescriptionRecord;
  onDone: () => void;
  trigger?: React.ReactNode;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const set = (k: keyof typeof empty) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (open && existing) {
      setF({
        medicationName: existing.medicationName, activeIngredient: existing.activeIngredient ?? "", strength: existing.strength ?? "",
        formulation: existing.formulation ?? "", dose: existing.dose ?? "", route: existing.route ?? "oral",
        frequencyPerDay: String(existing.frequencyPerDay), durationDays: existing.durationDays?.toString() ?? "",
        quantity: existing.quantity?.toString() ?? "", refillsAllowed: String(existing.refillsAllowed), instructions: existing.instructions,
        warnings: existing.warnings ?? "", notes: existing.notes ?? "", controlled: "no",
      });
    }
    if (open && !existing) setF(empty);
    if (open) { setErrors({}); setFormError(null); }
  }, [open, existing]);

  async function save() {
    const e: Record<string, string> = {};
    const req = t("onb.required");
    if (f.medicationName.trim().length < 2) e.medicationName = req;
    if (!f.dose.trim()) e.dose = req;
    if (f.instructions.trim().length < 3) e.instructions = req;
    if (f.controlled === "yes") e.controlled = t("rx.controlled.blocked");
    setErrors(e);
    if (Object.keys(e).length) return;

    setSaving(true);
    setFormError(null);
    const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
    const body = {
      medicationName: f.medicationName.trim(), activeIngredient: f.activeIngredient.trim(), strength: f.strength.trim(), formulation: f.formulation.trim(),
      dose: f.dose.trim(), route: f.route, frequencyPerDay: Number(f.frequencyPerDay), durationDays: num(f.durationDays), quantity: num(f.quantity),
      refillsAllowed: Number(f.refillsAllowed) || 0, instructions: f.instructions.trim(), warnings: f.warnings.trim(), notes: f.notes.trim(),
      controlledSubstance: false,
    };
    try {
      if (existing) await apiRequest("PATCH", `/api/prescriptions/${existing.id}`, body);
      else await apiRequest("POST", "/api/prescriptions", { ...body, pairingRequestId: pairingId });
      toast({ title: t("rx.form.savedDraft"), description: t("rx.form.savedDraftBody") });
      setOpen(false);
      onDone();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? <Button size="sm" className="gap-1"><Plus className="h-3.5 w-3.5" /> {t("rx.form.new")}</Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? t("rx.form.editTitle") : t("rx.form.title")}</DialogTitle>
          <DialogDescription>{t("rx.form.intro")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field id="rx-name" label={t("rx.form.medication")} error={errors.medicationName}>{(a) => <Input {...a} value={f.medicationName} onChange={(e) => set("medicationName")(e.target.value)} />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="rx-ingredient" label={t("rx.form.ingredient")} optional>{(a) => <Input {...a} dir="ltr" value={f.activeIngredient} onChange={(e) => set("activeIngredient")(e.target.value)} />}</Field>
            <Field id="rx-strength" label={t("rx.form.strength")} hint={t("rx.form.strengthHint")} optional>{(a) => <Input {...a} dir="ltr" value={f.strength} onChange={(e) => set("strength")(e.target.value)} />}</Field>
            <Field id="rx-form" label={t("rx.form.formulation")} hint={t("rx.form.formulationHint")} optional>{(a) => <Input {...a} value={f.formulation} onChange={(e) => set("formulation")(e.target.value)} />}</Field>
            <Field id="rx-route" label={t("rx.route")}>
              {(a) => (
                <NativeSelect {...a} value={f.route} onChange={(e) => set("route")(e.target.value)}>
                  {ROUTES.map((r) => <option key={r} value={r}>{t(`rx.route.${r}` as MessageKey)}</option>)}
                </NativeSelect>
              )}
            </Field>
          </div>
          <Field id="rx-dose" label={t("rx.dose")} hint={t("rx.form.doseHint")} error={errors.dose}>{(a) => <Input {...a} value={f.dose} onChange={(e) => set("dose")(e.target.value)} />}</Field>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field id="rx-freq" label={t("rx.form.frequency")}>
              {(a) => <NativeSelect {...a} value={f.frequencyPerDay} onChange={(e) => set("frequencyPerDay")(e.target.value)}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</NativeSelect>}
            </Field>
            <Field id="rx-days" label={t("rx.form.duration")} optional>{(a) => <Input {...a} type="number" min={1} max={365} inputMode="numeric" dir="ltr" value={f.durationDays} onChange={(e) => set("durationDays")(e.target.value)} />}</Field>
            <Field id="rx-qty" label={t("rx.form.quantity")} optional>{(a) => <Input {...a} type="number" min={1} inputMode="numeric" dir="ltr" value={f.quantity} onChange={(e) => set("quantity")(e.target.value)} />}</Field>
            <Field id="rx-refills" label={t("rx.form.refills")}>{(a) => <Input {...a} type="number" min={0} max={12} inputMode="numeric" dir="ltr" value={f.refillsAllowed} onChange={(e) => set("refillsAllowed")(e.target.value)} />}</Field>
          </div>
          <Field id="rx-instructions" label={t("rx.form.instructions")} hint={t("rx.form.instructionsHint")} error={errors.instructions}>{(a) => <Textarea {...a} rows={3} value={f.instructions} onChange={(e) => set("instructions")(e.target.value)} />}</Field>
          <Field id="rx-warnings" label={t("rx.form.warnings")} optional>{(a) => <Textarea {...a} rows={2} value={f.warnings} onChange={(e) => set("warnings")(e.target.value)} />}</Field>
          <Field id="rx-notes" label={t("rx.form.notes")} hint={t("rx.form.notesHint")} optional>{(a) => <Textarea {...a} rows={2} value={f.notes} onChange={(e) => set("notes")(e.target.value)} />}</Field>
          <Field id="rx-controlled" label={t("rx.form.controlled")} error={errors.controlled}>
            {(a) => (
              <NativeSelect {...a} value={f.controlled} onChange={(e) => set("controlled")(e.target.value)}>
                <option value="no">{t("rx.form.controlled.no")}</option>
                <option value="yes">{t("rx.form.controlled.yes")}</option>
              </NativeSelect>
            )}
          </Field>
          {formError && <p role="alert" className="font-medium text-destructive">{formError}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button disabled={saving} onClick={save}>{saving ? t("common.saving") : t("rx.form.saveDraft")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
