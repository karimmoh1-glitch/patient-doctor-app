import { useState } from "react";
import { Link } from "wouter";
import { User, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PublicLayout from "@/components/public-layout";
import PasswordField from "@/components/password-field";
import { useAppConfig } from "@/hooks/use-app-config";
import { SESSION_NOTICE_KEY } from "@/hooks/use-auth";
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
  onDemoLogin,
}: {
  onLogin: (email: string, password: string) => Promise<unknown>;
  onDemoLogin?: (role: "patient" | "doctor") => Promise<unknown>;
}) {
  const { t } = useI18n();
  const config = useAppConfig();
  const [expired] = useState(takeSessionNotice);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState<"patient" | "doctor" | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await onLogin(email, password);
    } catch (err: any) {
      setError(err.message || t("auth.login.failed"));
    } finally {
      setLoading(false);
    }
  }

  async function demo(role: "patient" | "doctor") {
    if (!onDemoLogin) return;
    setError(null);
    setDemoLoading(role);
    try {
      await onDemoLogin(role);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDemoLoading(null);
    }
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

      {config?.demoMode && onDemoLogin && (
        <section aria-labelledby="demo" className="mt-8 space-y-3 rounded-2xl border-2 border-dashed border-input p-4">
          <h2 id="demo" className="text-lg font-semibold">{t("auth.demo.title")}</h2>
          <p className="text-muted-foreground">{t("auth.demo.body")}</p>
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" disabled={!!demoLoading} onClick={() => demo("patient")}>
              <User aria-hidden="true" /> {demoLoading === "patient" ? "…" : t("auth.demo.patient")}
            </Button>
            <Button type="button" variant="outline" disabled={!!demoLoading} onClick={() => demo("doctor")}>
              <Stethoscope aria-hidden="true" /> {demoLoading === "doctor" ? "…" : t("auth.demo.doctor")}
            </Button>
          </div>
        </section>
      )}
    </PublicLayout>
  );
}
