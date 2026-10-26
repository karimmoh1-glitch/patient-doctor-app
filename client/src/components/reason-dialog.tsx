import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";

// Asks the reviewer for the words that will be sent to the applicant.
export function ReasonDialog({ trigger, title, description, label, confirm, required, onSubmit }: {
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

