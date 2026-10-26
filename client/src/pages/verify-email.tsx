import { useEffect, useState } from "react";
import { Link } from "wouter";
import PublicLayout from "@/components/public-layout";
import PageHeader from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useI18n } from "@/lib/i18n";

/** Opened from the link in the confirmation e-mail. The token is in the URL fragment: it is removed from the address bar at once. */
export default function VerifyEmail() {
  const { t } = useI18n();
  const [state, setState] = useState<"working" | "done" | "invalid">("working");
  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (token) history.replaceState(null, "", window.location.pathname);
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return setState("invalid");
    apiRequest("POST", "/api/auth/email/verify", { token }).then(() => setState("done"), () => setState("invalid"));
  }, []);
  return (
    <PublicLayout narrow>
      <div className="space-y-6">
        <PageHeader title={t("confirm.title")} description={state === "working" ? t("hp.loading") : state === "done" ? t("confirm.done") : t("confirm.invalid")} />
        {state !== "working" && <Button asChild size="lg"><Link href="/">{t("confirm.home")}</Link></Button>}
      </div>
    </PublicLayout>
  );
}
