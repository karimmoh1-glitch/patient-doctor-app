import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import PublicLayout from "@/components/public-layout";
import PasswordField from "@/components/password-field";

interface InviteDetails {
  name: string;
  relationshipLabel: string;
  patientName: string;
  hasAccount: boolean;
}

export default function AcceptCareCircleInvite({ onAccept }: { onAccept: (token: string, password: string) => Promise<unknown> }) {
  const [, setLocation] = useLocation();
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [details, setDetails] = useState<InviteDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/care-circle/invitations/validate/${token}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "This invitation link isn't valid any more.");
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
      setError(err.message || "We couldn't accept the invitation. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!token || loadError) {
    return (
      <PublicLayout narrow>
        <h1 className="mb-3 text-3xl font-semibold">This invitation can't be used</h1>
        <p className="text-lg text-muted-foreground">
          {loadError || "This link is missing part of its address."} Invitations work for 7 days and only once. Please ask the person who invited you to send a new one.
        </p>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout narrow>
      <h1 className="mb-3 text-3xl font-semibold">Join {details?.patientName ?? "their"}'s Care Circle</h1>
      {details ? (
        <>
          <p className="mb-6 text-lg text-muted-foreground">
            {details.patientName} has invited you as their "{details.relationshipLabel}". You will only see what they choose to share, and they can stop sharing at any time.
          </p>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="password" className="text-base">{details.hasAccount ? "Your Avela password" : "Choose a password"}</Label>
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
                <p className="text-muted-foreground">You already have a helper account with this email, so we need its password to add this person to it.</p>
              )}
            </div>
            {error && <p id="invite-error" role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={loading}>{loading ? "Joining…" : "Accept the invitation"}</Button>
          </form>
        </>
      ) : (
        <p role="status" className="text-lg text-muted-foreground">Checking your invitation…</p>
      )}
    </PublicLayout>
  );
}
