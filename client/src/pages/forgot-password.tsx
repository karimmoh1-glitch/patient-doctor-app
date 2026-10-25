import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { parseErrorMessage } from "@/lib/api-error";
import { useI18n } from "@/lib/i18n";

export default function ForgotPassword() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(await parseErrorMessage(res, t("forgotpw.error")));
      setSent(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("forgotpw.title")}</CardTitle>
          {!sent && <CardDescription>{t("forgotpw.desc")}</CardDescription>}
        </CardHeader>
        <CardContent>
          {sent ? (
            <p className="text-sm text-muted-foreground">
              {t("forgotpw.sent")}
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">{t("forgotpw.email")}</Label>
                <Input id="email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? t("forgotpw.sending") : t("forgotpw.send")}
              </Button>
            </form>
          )}
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link href="/login" className="text-primary underline-offset-4 hover:underline">
              {t("forgotpw.back")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
