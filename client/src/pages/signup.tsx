import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import PublicLayout from "@/components/public-layout";
import PasswordField from "@/components/password-field";
import PageHeader from "@/components/page-header";
import StepProgress from "@/components/step-progress";
import { Field } from "@/components/form-field";
import { US_STATES } from "@shared/specialties";
import { LOCALES, useI18n, type Locale } from "@/lib/i18n";

export const WELCOME_KEY = "pdapp_show_welcome";

export default function Signup({
  onSignup,
}: {
  onSignup: (fields: { name: string; email: string; password: string; state: string; language: string }) => Promise<unknown>;
}) {
  const { t, locale, setLocale } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState("");
  const [errors, setErrors] = useState<{ state?: string; form?: string }>({});
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!state) {
      setErrors({ state: t("auth.signup.stateRequired") });
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      try { sessionStorage.setItem(WELCOME_KEY, "1"); } catch { /* the welcome is a courtesy */ }
      await onSignup({ name, email, password, state, language: locale });
    } catch (err: any) {
      try { sessionStorage.removeItem(WELCOME_KEY); } catch { /* ignore */ }
      setErrors({ form: err.message || t("auth.signup.failed") });
    } finally {
      setLoading(false);
    }
  }

  return (
    <PublicLayout narrow>
      <div className="space-y-6">
        <StepProgress steps={[t("auth.signup.step.account"), t("auth.signup.step.welcome")]} current={0} />
        <PageHeader title={t("auth.signup.title")} description={t("auth.signup.intro")} />
        <form onSubmit={handleSubmit} className="space-y-5">
          <Field id="name" label={t("auth.name")}>
            {(a) => <Input {...a} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />}
          </Field>
          <Field id="email" label={t("auth.email")}>
            {(a) => <Input {...a} type="email" inputMode="email" dir="ltr" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
          </Field>
          <Field id="state" label={t("auth.signup.state")} hint={t("auth.signup.stateWhy")} error={errors.state}>
            {(a) => (
              <NativeSelect {...a} value={state} onChange={(e) => setState(e.target.value)} required>
                <option value="">{t("auth.signup.stateChoose")}</option>
                {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </NativeSelect>
            )}
          </Field>
          <Field id="language" label={t("auth.signup.language")} hint={t("auth.signup.languageWhy")}>
            {(a) => (
              <NativeSelect {...a} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                {LOCALES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.label}</option>)}
              </NativeSelect>
            )}
          </Field>
          <Field id="password" label={t("auth.signup.password")} hint={t("auth.signup.passwordHelp")}>
            {(a) => <PasswordField id={a.id} value={password} onChange={setPassword} autoComplete="new-password" minLength={8} describedBy={a["aria-describedby"]} />}
          </Field>
          {errors.form && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{errors.form}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={loading}>{loading ? t("auth.signup.submitting") : t("auth.signup.submit")}</Button>
        </form>
        <p className="text-lg">
          {t("auth.signup.have")}{" "}
          <Link href="/login" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">{t("public.signIn")}</Link>
        </p>
      </div>
    </PublicLayout>
  );
}
