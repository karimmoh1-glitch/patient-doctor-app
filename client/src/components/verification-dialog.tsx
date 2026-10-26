import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";

// Approving is also verifying the licence, so the reviewer says how it was checked, what they saw, and until when it is valid.
// That record is what lets Avela say "checked by a person" instead of "verified".
export function VerificationDialog({ trigger, title, description, confirmLabel, withExpiry = true, onSubmit }: { trigger: React.ReactNode; title: string; description: string; confirmLabel: string; withExpiry?: boolean; onSubmit: (verification: { source: string; evidenceNote: string; expiresAt: string }) => Promise<void> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("document_review");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState(() => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const valid = note.trim().length >= 10 && /^\d{4}-\d{2}-\d{2}$/.test(expires);
  async function submit() {
    setBusy(true);
    try {
      await onSubmit({ source, evidenceNote: note.trim(), expiresAt: new Date(`${expires}T23:59:59Z`).toISOString() });
      setOpen(false);
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
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="verify-source" className="text-base">{t("admin.verify.source")}</Label>
            <NativeSelect id="verify-source" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="document_review">{t("admin.verify.source.document_review")}</option>
              <option value="registry_lookup">{t("admin.verify.source.registry_lookup")}</option>
              <option value="issuer_confirmation">{t("admin.verify.source.issuer_confirmation")}</option>
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor="verify-note" className="text-base">{t("admin.verify.note")}</Label>
            <Textarea id="verify-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby="verify-note-hint" />
            <p id="verify-note-hint" className="text-sm text-muted-foreground">{t("admin.verify.note.hint")}</p>
          </div>
          {withExpiry && <div className="space-y-2">
            <Label htmlFor="verify-expires" className="text-base">{t("admin.verify.expires")}</Label>
            <Input id="verify-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            <p className="text-sm text-muted-foreground">{t("admin.verify.expires.hint")}</p>
          </div>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button disabled={busy || !valid} onClick={submit}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

