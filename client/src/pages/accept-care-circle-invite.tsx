import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import PublicLayout from "@/components/public-layout";
import PasswordField from "@/components/password-field";
import { useI18n } from "@/lib/i18n";

interface InviteDetails {
  name: string;
  relationshipLabel: string;
  patientName: string;
  hasAccount: boolean;
}

export default function AcceptCareCircleInvite({ onAccept }: { onAccept: (token: string, password: string) => Promise<unknown> }) {
  const [, setLocation] = useLocation();
  const { t } = useI18n();
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [details, setDetails] = useState<InviteDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch("/api/care-circle/invitations/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || t("invite.invalid.default"));
        return res.json();
      })
      .then(setDetails)
      .catch((err) => setLoadError(err.message));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await onAccept(token, password);
      setLocation("/caregiver");
    } catch (err: any) {
      setError(err.message || t("invite.error.accept"));
    } finally {
      setLoading(false);
    }
  }

  if (!token || loadError) {
    return (
      <PublicLayout narrow>
        <h1 className="mb-3 text-3xl font-semibold">{t("invite.invalid.title")}</h1>
        <p className="text-lg text-muted-foreground">
          {loadError || t("invite.invalid.missing")} {t("invite.invalid.rest")}
        </p>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout narrow>
      <h1 className="mb-3 text-3xl font-semibold">{details ? t("invite.join", { name: details.patientName }) : t("invite.join.generic")}</h1>
      {details ? (
        <>
          <p className="mb-6 text-lg text-muted-foreground">
            {t("invite.body", { name: details.patientName, relationship: details.relationshipLabel })}
          </p>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="password" className="text-base">{details.hasAccount ? t("invite.password.existing") : t("invite.password.new")}</Label>
              <PasswordField
                id="password"
                value={password}
                onChange={setPassword}
                autoComplete={details.hasAccount ? "current-password" : "new-password"}
                minLength={8}
                describedBy={error ? "invite-error" : undefined}
                invalid={!!error}
              />
              {details.hasAccount && (
                <p className="text-muted-foreground">{t("invite.hasAccountNote")}</p>
              )}
            </div>
            {error && <p id="invite-error" role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={loading}>{loading ? t("invite.joining") : t("invite.accept")}</Button>
          </form>
        </>
      ) : (
        <p role="status" className="text-lg text-muted-foreground">{t("invite.checking")}</p>
      )}
    </PublicLayout>
  );
}
