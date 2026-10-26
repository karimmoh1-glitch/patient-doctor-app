import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useI18n } from "@/lib/i18n";

/** Reminder e-mail goes only to an address the person has confirmed. This asks for a link to be sent, and says what actually happened. */
export default function ConfirmEmailPrompt() {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "busy" | "sent" | "notSent">("idle");
  async function ask() {
    setState("busy");
    try {
      const res = await apiRequest("POST", "/api/auth/email/verify/request");
      const body = await res.json();
      setState(body.verified ? "sent" : body.sent ? "sent" : "notSent");
    } catch {
      setState("notSent");
    }
  }
  return (
    <div className="space-y-2 rounded-xl bg-sand p-3 text-base text-sand-foreground">
      <p>{t("confirm.why")}</p>
      {state === "sent" ? <p role="status" className="font-medium">{t("confirm.sent")}</p> : (
        <Button variant="outline" onClick={ask} disabled={state === "busy"}>{t("confirm.send")}</Button>
      )}
      {state === "notSent" && <p role="alert" className="font-medium">{t("confirm.notSent")}</p>}
    </div>
  );
}
