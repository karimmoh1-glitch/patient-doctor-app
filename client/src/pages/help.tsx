import { Link } from "wouter";
import { Phone, Mail, MessageCircle, Siren, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAppConfig } from "@/hooks/use-app-config";
import { EMERGENCY_NUMBER, EMERGENCY_TEL } from "@/lib/emergency";
import { useI18n } from "@/lib/i18n";
import { Ltr } from "@/components/ltr";
import PageHeader from "@/components/page-header";

// Everything on this page is true of the running deployment: a support
// line or email is shown only when the operator has actually configured one,
// and the page says so plainly when nobody is staffing a channel. There is
// no pretend "chat with an agent" box.
export default function Help({ signedIn = true }: { signedIn?: boolean }) {
  const config = useAppConfig();
  const { t } = useI18n();
  const support = config?.support;
  const telSupport = support?.phone ? `tel:${support.phone.replace(/[^\d+]/g, "")}` : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t("help.title")} description={t("help.intro")} />

      <Card className="border-2 border-destructive">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-2xl"><Siren className="h-6 w-6 text-destructive" aria-hidden="true" /> {t("help.emergency.title")}</CardTitle>
          <CardDescription className="text-base">
            {t("help.emergency.body")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button asChild size="lg" variant="destructive">
            <a href={EMERGENCY_TEL}><Phone aria-hidden="true" /> {t("emergency.callNow", { number: EMERGENCY_NUMBER })}</a>
          </Button>
          <Button asChild size="lg" variant="outline"><Link href="/sos">{t("help.more")}</Link></Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{t("help.team.title")}</CardTitle>
          <CardDescription className="text-base">{t("help.team.body")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {telSupport || support?.email ? (
            <>
              <div className="flex flex-wrap gap-3">
                {telSupport && (
                  <Button asChild size="lg"><a href={telSupport}><Phone aria-hidden="true" /> {t("help.team.call")} <Ltr>{support?.phone}</Ltr></a></Button>
                )}
                {support?.email && (
                  <Button asChild size="lg" variant="outline"><a href={`mailto:${support.email}`}><Mail aria-hidden="true" /> {t("help.team.email")} <Ltr>{support.email}</Ltr></a></Button>
                )}
              </div>
              {support?.hours && (
                <p className="flex items-start gap-2 text-muted-foreground"><Clock className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" /> {support.hours}</p>
              )}
            </>
          ) : (
            <p className="rounded-lg border-2 border-input p-4">
              {t("help.support.none")}
            </p>
          )}
        </CardContent>
      </Card>

      {signedIn && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">{t("help.message.title")}</CardTitle>
              <CardDescription className="text-base">{t("help.message.body")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="lg" variant="outline"><Link href="/messages"><MessageCircle aria-hidden="true" /> {t("help.message.button")}</Link></Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-xl">{t("help.screen.title")}</CardTitle>
              <CardDescription className="text-base">{t("help.screen.body")}</CardDescription>
            </CardHeader>
          </Card>
        </>
      )}
    </div>
  );
}
