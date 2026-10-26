import { useState } from "react";
import { Download, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import ConfirmAction from "@/components/confirm-action";
import PasswordField from "@/components/password-field";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";
import type { AuthUser } from "@/hooks/use-auth";

/**
 * The person's own controls over their account: end every session, download a
 * copy of their information, and close the account. The last two are for
 * patients, whose records they are.
 */
export default function AccountControls({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function signOutEverywhere() {
    try {
      await apiRequest("POST", "/api/auth/logout-all");
    } finally {
      onSignOut();
    }
  }

  async function download() {
    setBusy(true);
    try {
      const res = await apiRequest("GET", "/api/me/export");
      const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `avela-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: t("acct.export.failed"), description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function closeAccount() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/me/delete-request", { confirm: true, password });
      onSignOut();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="acct-heading" className="space-y-3 border-t border-border pt-5">
      <h3 id="acct-heading" className="text-base font-semibold">{t("acct.title")}</h3>
      <ConfirmAction
        trigger={<Button variant="outline" className="w-full justify-start"><LogOut aria-hidden="true" /> {t("acct.everywhere")}</Button>}
        title={t("acct.everywhere.title")}
        description={t("acct.everywhere.body")}
        confirmLabel={t("acct.everywhere.yes")}
        cancelLabel={t("settings.signOut.no")}
        onConfirm={signOutEverywhere}
      />
      {user.role === "patient" && (
        <>
          <Button variant="outline" className="w-full justify-start" onClick={download} disabled={busy}>
            <Download aria-hidden="true" /> {t("acct.export")}
          </Button>
          <p className="text-base text-muted-foreground">{t("acct.export.note")}</p>
          <Dialog open={closeOpen} onOpenChange={(o) => { setCloseOpen(o); setError(null); setPassword(""); }}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full justify-start text-destructive"><ShieldAlert aria-hidden="true" /> {t("acct.close")}</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("acct.close.title")}</DialogTitle>
                <DialogDescription>{t("acct.close.body")}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="close-password" className="text-base">{t("acct.close.password")}</Label>
                <PasswordField id="close-password" value={password} onChange={setPassword} autoComplete="current-password" describedBy={error ? "close-error" : undefined} invalid={!!error} />
                {error && <p id="close-error" role="alert" className="font-medium text-destructive">{error}</p>}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setCloseOpen(false)}>{t("acct.close.no")}</Button>
                <Button variant="destructive" disabled={busy || !password} onClick={closeAccount}>{t("acct.close.yes")}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </section>
  );
}
