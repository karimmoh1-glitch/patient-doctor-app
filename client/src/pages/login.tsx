import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PublicLayout from "@/components/public-layout";
import PasswordField from "@/components/password-field";
import MfaFlow, { type MfaApi } from "@/components/mfa-flow";
import { SESSION_NOTICE_KEY, type PendingMfa, type SignInResult } from "@/hooks/use-auth";
import { useI18n } from "@/lib/i18n";

function takeSessionNotice(): boolean {
  try {
    const v = sessionStorage.getItem(SESSION_NOTICE_KEY);
    if (v) sessionStorage.removeItem(SESSION_NOTICE_KEY);
    return v === "expired";
  } catch {
    return false;
  }
}

export default function Login({
  onLogin,
  mfa,
}: {
  onLogin: (email: string, password: string) => Promise<SignInResult>;
  mfa: MfaApi;
}) {
  const { t } = useI18n();
  const [expired] = useState(takeSessionNotice);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingMfa | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await onLogin(email, password);
      if (result.kind === "mfa") setPending(result.pending);
    } catch (err: any) {
      setError(err.message || t("auth.login.failed"));
    } finally {
      setLoading(false);
    }
  }


  if (pending) {
    return (
      <PublicLayout narrow>
        <MfaFlow pending={pending} api={mfa} />
      </PublicLayout>
    );
  }

  return (
    <PublicLayout narrow>
      <h1 className="mb-2 font-display text-3xl font-semibold">{t("auth.login.title")}</h1>
      <p className="mb-6 text-lg text-muted-foreground">{t("auth.login.intro")}</p>
      {expired && <p role="status" className="mb-5 rounded-xl border-2 border-input bg-secondary p-4 text-lg">{t("auth.login.expired")}</p>}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email" className="text-base">{t("auth.email")}</Label>
          <Input id="email" type="email" inputMode="email" dir="ltr" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? "login-error" : undefined} aria-invalid={error ? true : undefined} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password" className="text-base">{t("auth.password")}</Label>
          <PasswordField id="password" value={password} onChange={setPassword} autoComplete="current-password" describedBy={error ? "login-error" : undefined} invalid={!!error} />
        </div>
        {error && <p id="login-error" role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={loading}>{loading ? t("auth.login.submitting") : t("auth.login.submit")}</Button>
      </form>

      <p className="mt-5">
        <Link href="/forgot-password" className="inline-flex min-h-11 items-center text-lg font-medium text-primary underline underline-offset-4">{t("auth.login.forgot")}</Link>
      </p>
      <p className="text-lg">
        {t("auth.login.newHere")}{" "}
        <Link href="/get-started" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">{t("auth.createAccount")}</Link>
      </p>

    </PublicLayout>
  );
}
