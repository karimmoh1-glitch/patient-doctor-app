import { useState } from "react";
import { Link } from "wouter";
import { ClipboardCheck, ShieldCheck, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PublicLayout from "@/components/public-layout";
import PasswordField from "@/components/password-field";
import PageHeader from "@/components/page-header";
import StepProgress from "@/components/step-progress";
import { Field } from "@/components/form-field";
import MfaFlow, { type MfaApi } from "@/components/mfa-flow";
import type { PendingMfa, SignInResult } from "@/hooks/use-auth";
import { useI18n } from "@/lib/i18n";

// Registering creates the account only. A doctor cannot see any patient, and
// patients cannot see them, until an administrator approves their application.
export default function JoinDoctor({
  onRegister,
  mfa,
}: {
  onRegister: (fields: { name: string; email: string; password: string; language: string }) => Promise<SignInResult>;
  mfa: MfaApi;
}) {
  const { t, locale } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingMfa | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await onRegister({ name, email, password, language: locale });
      if (result.kind === "mfa") setPending(result.pending);
    } catch (err: any) {
      setError(err.message || t("onb.join.failed"));
    } finally {
      setLoading(false);
    }
  }

  const points = [
    { icon: ClipboardCheck, text: t("onb.join.p1") },
    { icon: ShieldCheck, text: t("onb.join.p2") },
    { icon: Stethoscope, text: t("onb.join.p3") },
  ];

  if (pending) {
    return (
      <PublicLayout narrow>
        <MfaFlow pending={pending} api={mfa} />
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <div className="grid gap-10 md:grid-cols-[1fr_1.1fr]">
        <div className="space-y-6">
          <PageHeader title={t("onb.join.title")} description={t("onb.join.intro")} />
          <ul className="space-y-4">
            {points.map((p) => (
              <li key={p.text} className="flex gap-3 text-lg">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary"><p.icon className="h-5 w-5" aria-hidden="true" /></span>
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-6 rounded-3xl border border-border bg-card p-6 shadow-soft md:p-8">
          <StepProgress steps={[t("onb.step.account"), t("onb.step.professional"), t("onb.step.profile"), t("onb.step.review")]} current={0} />
          <form onSubmit={submit} className="space-y-5">
            <Field id="doc-name" label={t("onb.join.name")} hint={t("onb.join.nameHint")}>
              {(a) => <Input {...a} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />}
            </Field>
            <Field id="doc-email" label={t("auth.email")}>
              {(a) => <Input {...a} type="email" inputMode="email" dir="ltr" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
            </Field>
            <Field id="doc-password" label={t("auth.signup.password")} hint={t("auth.signup.passwordHelp")}>
              {(a) => <PasswordField id={a.id} value={password} onChange={setPassword} autoComplete="new-password" minLength={8} describedBy={a["aria-describedby"]} />}
            </Field>
            {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={loading}>{loading ? t("onb.join.submitting") : t("onb.join.submit")}</Button>
          </form>
          <p className="text-lg">
            {t("auth.signup.have")}{" "}
            <Link href="/login" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">{t("public.signIn")}</Link>
          </p>
        </div>
      </div>
    </PublicLayout>
  );
}
