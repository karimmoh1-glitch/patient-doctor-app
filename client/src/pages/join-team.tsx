import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import PublicLayout from "@/components/public-layout";
import PageHeader from "@/components/page-header";
import PasswordField from "@/components/password-field";
import MfaFlow, { type MfaApi } from "@/components/mfa-flow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/form-field";
import { Ltr } from "@/components/ltr";
import { apiRequest } from "@/lib/queryClient";
import { useI18n, type MessageKey } from "@/lib/i18n";
import type { AuthUser, PendingMfa, SignInResult } from "@/hooks/use-auth";

const KEY = "avela.pending-team-invite";
interface Preview { orgName: string; role: string; email: string; accountExists: boolean }

/** Opened from an invitation link. The token is in the URL fragment, so opening the page sends it nowhere; it is removed from the address bar at once. */
export default function JoinTeam({ user, registerStaff, mfa }: { user: AuthUser | null; registerStaff: (f: { token: string; name: string; password: string; language: string }) => Promise<SignInResult>; mfa: MfaApi }) {
  const { t, locale } = useI18n();
  const [, go] = useLocation();
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingMfa | null>(null);

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    let found: string | null = /^[A-Za-z0-9_-]{40,60}$/.test(fromHash) ? fromHash : null;
    if (!found) try { found = sessionStorage.getItem(KEY); } catch { /* none */ }
    if (fromHash) history.replaceState(null, "", window.location.pathname);
    if (found) {
      try { sessionStorage.setItem(KEY, found); } catch { /* kept in memory only */ }
      setToken(found);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    apiRequest("POST", "/api/orgs/invitations/preview", { token })
      .then((r) => r.json())
      .then(setPreview)
      .catch(() => { setError(t("team.invalid")); try { sessionStorage.removeItem(KEY); } catch { /* ok */ } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Once the sign-in code is set up the person is signed in: take them to their organization.
  useEffect(() => {
    if (pending && user) go("/org");
  }, [pending, user, go]);

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await registerStaff({ token: token!, name, password, language: locale });
      try { sessionStorage.removeItem(KEY); } catch { /* ok */ }
      if (result.kind === "mfa") setPending(result.pending);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function joinWithAccount() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/orgs/invitations/accept", { token });
      const body = await res.json();
      try { sessionStorage.removeItem(KEY); } catch { /* ok */ }
      go(`/org/${body.orgId}`);
    } catch (err: any) {
      setError(t("team.cannotJoin"));
    } finally {
      setBusy(false);
    }
  }

  if (pending) return <PublicLayout narrow><MfaFlow pending={pending} api={mfa} /></PublicLayout>;

  return (
    <PublicLayout narrow>
      <div className="space-y-6">
        <PageHeader title={t("team.title")} description={t("team.intro")} />
        {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
        {!token && !error && <p className="text-lg">{t("team.noLink")}</p>}
        {preview && (
          <section aria-labelledby="team-who" className="space-y-4 rounded-2xl border-2 border-input bg-card p-5">
            <h2 id="team-who" className="font-display text-2xl">{t("team.from", { org: preview.orgName })}</h2>
            <p className="text-lg">{t("team.role", { role: t(`org.role.${preview.role}` as MessageKey) })}</p>
            <p className="text-base text-muted-foreground">{t(`org.role.${preview.role}.can` as MessageKey)}</p>
            <p className="text-base text-muted-foreground">{t("team.noClinical")}</p>
            <p className="text-lg">{t("team.forEmail")} <Ltr>{preview.email}</Ltr></p>
            {user ? (
              user.email.toLowerCase() === preview.email.toLowerCase() ? (
                <Button size="lg" onClick={joinWithAccount} disabled={busy}>{t("team.join")}</Button>
              ) : (
                <p role="alert" className="font-medium">{t("team.wrongAccount")}</p>
              )
            ) : preview.accountExists ? (
              <div className="space-y-2">
                <p className="text-lg">{t("team.signInFirst")}</p>
                <Button asChild size="lg"><Link href="/login">{t("conn.signin.login")}</Link></Button>
              </div>
            ) : preview.role === "clinician" ? (
              <p className="text-lg">{t("team.clinicianNeedsAccount")} <Link href="/join/doctor" className="font-medium text-primary underline underline-offset-4">{t("public.nav.doctors")}</Link></p>
            ) : (
              <form onSubmit={createAccount} className="space-y-4" noValidate>
                <Field id="team-name" label={t("onb.join.name")}>{(a) => <Input {...a} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
                <Field id="team-password" label={t("auth.password")}>{(a) => <PasswordField id="team-password" value={password} onChange={setPassword} autoComplete="new-password" describedBy={a["aria-describedby"]} minLength={8} />}</Field>
                <p className="text-base text-muted-foreground">{t("team.mfaNote")}</p>
                <Button type="submit" size="lg" disabled={busy || !name.trim() || password.length < 8}>{busy ? t("common.saving") : t("team.create")}</Button>
              </form>
            )}
          </section>
        )}
      </div>
    </PublicLayout>
  );
}
