import { useState } from "react";
import { Download, KeyRound, LogOut, ShieldAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
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
      {(user.role === "doctor" || user.role === "admin") && <SignInCodeControls />}
      {(user.role === "patient" || user.role === "doctor") && <ReadReceiptControl />}
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

/** For clinicians and administrators: whether the sign-in code is on, how many recovery codes remain, and replacing them. */
function SignInCodeControls() {
  const { t } = useI18n();
  const status = useQuery<{ required: boolean; enabled: boolean; recoveryCodesLeft: number }>({ queryKey: ["/api/auth/mfa/status"], staleTime: 0 });
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[] | null>(null);

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/auth/mfa/recovery-codes", { code });
      setFresh((await res.json()).recoveryCodes);
      status.refetch();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!status.data?.enabled) return null;
  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <p className="flex items-center gap-2 text-base font-semibold"><KeyRound className="h-5 w-5" aria-hidden="true" /> {t("mfa.settings.title")}</p>
      <p className="text-base text-muted-foreground">{t("mfa.settings.on")} {t("mfa.settings.left", { count: status.data.recoveryCodesLeft })}</p>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); setCode(""); setError(null); setFresh(null); }}>
        <DialogTrigger asChild><Button variant="outline" className="w-full justify-start">{t("mfa.settings.regenerate")}</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mfa.settings.regenerate")}</DialogTitle>
            <DialogDescription>{fresh ? t("mfa.recovery.intro") : t("mfa.settings.regenBody")}</DialogDescription>
          </DialogHeader>
          {fresh ? (
            <ul dir="ltr" className="grid grid-cols-1 gap-2 rounded-xl border-2 border-input p-3 font-mono text-lg sm:grid-cols-2" data-testid="new-recovery-codes">{fresh.map((c) => <li key={c}>{c}</li>)}</ul>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="regen-code" className="text-base">{t("mfa.code.label")}</Label>
              <Input id="regen-code" dir="ltr" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter>
            {fresh ? <Button onClick={() => setOpen(false)}>{t("mfa.recovery.continue")}</Button> : <Button disabled={busy || code.length !== 6} onClick={regenerate}>{t("mfa.settings.regenSubmit")}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Whether the other side of a conversation may be told when this person has read their message. */
function ReadReceiptControl() {
  const { t } = useI18n();
  const me = useQuery<{ readReceipts?: boolean }>({ queryKey: ["/api/auth/me"], staleTime: 0 });
  const [busy, setBusy] = useState(false);
  const on = me.data?.readReceipts ?? true;
  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await apiRequest("PATCH", "/api/auth/me/preferences", { readReceipts: next });
      await me.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      <label className="flex min-h-12 cursor-pointer items-start gap-3 text-base font-medium">
        <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={on} disabled={busy || me.isLoading} onChange={(e) => toggle(e.target.checked)} />
        {t("msg.receipts")}
      </label>
      <p className="ps-9 text-base text-muted-foreground">{t("msg.receipts.help")}</p>
    </div>
  );
}
