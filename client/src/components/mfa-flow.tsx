import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AuthUser, PendingMfa } from "@/hooks/use-auth";
import { useI18n } from "@/lib/i18n";

export interface MfaApi {
  verify: (challenge: string, code: string) => Promise<unknown>;
  beginSetup: (challenge: string) => Promise<{ secret: string; otpauthUri: string; account: string }>;
  enable: (challenge: string, code: string) => Promise<{ user: AuthUser; recoveryCodes: string[] }>;
  finish: (user: AuthUser) => void;
}

/**
 * The second step of signing in for a doctor or administrator: either entering a code from their authenticator app
 * (or a recovery code), or, the first time, setting the app up and being shown their recovery codes once.
 */
export default function MfaFlow({ pending, api }: { pending: PendingMfa; api: MfaApi }) {
  return pending.step === "verify" ? <VerifyStep pending={pending} api={api} /> : <SetupStep pending={pending} api={api} />;
}

function VerifyStep({ pending, api }: { pending: PendingMfa; api: MfaApi }) {
  const { t } = useI18n();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.verify(pending.challenge, code);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5" aria-labelledby="mfa-title">
      <h1 id="mfa-title" className="font-display text-3xl font-semibold">{t("mfa.verify.title")}</h1>
      <p className="text-lg text-muted-foreground">{t("mfa.verify.intro")}</p>
      <p className="text-base text-muted-foreground" dir="ltr">{t("mfa.account", { email: pending.account.email })}</p>
      <div className="space-y-2">
        <Label htmlFor="mfa-code" className="text-base">{useRecovery ? t("mfa.recovery.label") : t("mfa.code.label")}</Label>
        {useRecovery ? (
          <Input id="mfa-code" dir="ltr" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)}
            aria-describedby={error ? "mfa-error" : "mfa-hint"} aria-invalid={error ? true : undefined} required />
        ) : (
          <Input id="mfa-code" dir="ltr" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-describedby={error ? "mfa-error" : undefined} aria-invalid={error ? true : undefined}
            className="text-center text-2xl tracking-[0.4em]" required />
        )}
        {useRecovery && <p id="mfa-hint" className="text-base text-muted-foreground">{t("mfa.recovery.hint")}</p>}
      </div>
      {error && <p id="mfa-error" role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
      <Button type="submit" size="lg" className="w-full" disabled={busy || (!useRecovery && code.length !== 6)}>
        {busy ? t("mfa.verify.submitting") : t("mfa.verify.submit")}
      </Button>
      <p>
        <button type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }}
          className="inline-flex min-h-11 items-center text-lg font-medium text-primary underline underline-offset-4">
          {useRecovery ? t("mfa.useApp") : t("mfa.useRecovery")}
        </button>
      </p>
      <p className="text-base text-muted-foreground">{t("mfa.lost")}</p>
    </form>
  );
}

function SetupStep({ pending, api }: { pending: PendingMfa; api: MfaApi }) {
  const { t } = useI18n();
  const [key, setKey] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ user: AuthUser; recoveryCodes: string[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return; // one key per visit to this step, even if the component re-renders
    asked.current = true;
    api.beginSetup(pending.challenge).then(
      (k) => {
        setKey(k);
        QRCode.toDataURL(k.otpauthUri, { margin: 1, width: 220 }).then(setQr, () => setQr(null));
      },
      (err) => setError(err.message),
    );
  }, [api, pending.challenge]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setDone(await api.enable(pending.challenge, code));
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section aria-labelledby="rec-title" className="space-y-5">
        <h1 id="rec-title" className="font-display text-3xl font-semibold">{t("mfa.recovery.title")}</h1>
        <p className="text-lg text-muted-foreground">{t("mfa.recovery.intro")}</p>
        <ul dir="ltr" className="grid grid-cols-1 gap-2 rounded-xl border-2 border-input bg-card p-4 font-mono text-lg sm:grid-cols-2" data-testid="recovery-codes">
          {done.recoveryCodes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <label className="flex min-h-12 cursor-pointer items-center gap-3 text-lg font-medium">
          <input type="checkbox" className="h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          {t("mfa.recovery.saved")}
        </label>
        <Button size="lg" className="w-full" disabled={!saved} onClick={() => api.finish(done.user)}>{t("mfa.recovery.continue")}</Button>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" aria-labelledby="setup-title">
      <h1 id="setup-title" className="font-display text-3xl font-semibold">{t("mfa.setup.title")}</h1>
      <p className="text-lg text-muted-foreground">{t("mfa.setup.intro")}</p>
      <p className="text-base text-muted-foreground" dir="ltr">{t("mfa.account", { email: pending.account.email })}</p>
      <p className="text-lg">{t("mfa.setup.step1")}</p>
      <p className="text-lg">{t("mfa.setup.step2")}</p>
      {!key && !error && <p role="status" className="text-lg text-muted-foreground">{t("mfa.setup.loading")}</p>}
      {key && (
        <div className="space-y-3 rounded-xl border-2 border-input bg-card p-4">
          {qr && <img src={qr} width={220} height={220} alt={t("mfa.setup.qrAlt")} className="mx-auto rounded-md bg-white" />}
          <p className="text-base font-semibold">{t("mfa.setup.key")}</p>
          <p dir="ltr" className="break-all font-mono text-xl tracking-wider" data-testid="mfa-secret">{key.secret.match(/.{1,4}/g)?.join(" ")}</p>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="setup-code" className="text-base">{t("mfa.setup.step3")}</Label>
        <Input id="setup-code" dir="ltr" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-describedby={error ? "setup-error" : undefined} aria-invalid={error ? true : undefined}
          className="text-center text-2xl tracking-[0.4em]" required />
      </div>
      {error && <p id="setup-error" role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
      <Button type="submit" size="lg" className="w-full" disabled={busy || !key || code.length !== 6}>{busy ? t("mfa.verify.submitting") : t("mfa.setup.submit")}</Button>
    </form>
  );
}
