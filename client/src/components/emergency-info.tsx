import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Ltr } from "@/components/ltr";
import { useAppConfig } from "@/hooks/use-app-config";
import { chooseCountry, useEmergency } from "@/lib/emergency";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { SUPPORTED_COUNTRIES, type CountryCode } from "@shared/emergency";

/**
 * Emergency numbers for the country the person chooses. Needs no sign-in. Says plainly what the numbers are, where they came
 * from, whether a person has reviewed them, and that Avela cannot send help.
 */
export default function EmergencyInfo() {
  const { t } = useI18n();
  const config = useAppConfig();
  const e = useEmergency();
  const data = e.country ? config?.emergency?.countries?.[e.country] : undefined;
  return (
    <div className="space-y-6">
      <p className="rounded-2xl border-2 border-destructive bg-card p-4 text-xl font-semibold">{t("emi.notService")}</p>

      <fieldset className="space-y-3">
        <legend className="text-2xl font-semibold">{t("emi.which")}</legend>
        <p className="text-base text-muted-foreground">{t("emi.which.hint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {SUPPORTED_COUNTRIES.map((c: CountryCode) => (
            <Button key={c} type="button" size="lg" variant={e.country === c ? "default" : "outline"} aria-pressed={e.country === c} className="min-h-16 text-xl" onClick={() => chooseCountry(c)}>
              {t(`hp.country.${c}` as MessageKey)}
            </Button>
          ))}
        </div>
      </fieldset>

      {e.needsCountry ? (
        <p role="status" className="text-xl">{t("emi.pick")}</p>
      ) : !data ? (
        <p role="status">{t("hp.loading")}</p>
      ) : !data.services ? (
        <section aria-labelledby="emi-none" className="space-y-2 rounded-2xl border-2 border-input bg-card p-4">
          <h2 id="emi-none" className="text-2xl font-semibold">{t(`hp.country.${data.code}` as MessageKey)}</h2>
          <p className="text-xl">{t("emi.unreviewed")}</p>
        </section>
      ) : (
        <section aria-labelledby="emi-numbers" className="space-y-4 rounded-2xl border-2 border-destructive bg-card p-4">
          <h2 id="emi-numbers" className="text-2xl font-semibold">{t("emi.numbersFor", { country: t(`hp.country.${data.code}` as MessageKey) })}</h2>
          <ul className="space-y-3">
            {data.services.map((s) => (
              <li key={s.kind}>
                <Button asChild size="lg" variant={s.kind === data.primary ? "destructive" : "outline"} className="min-h-16 w-full justify-start text-xl">
                  <a href={`tel:${s.number}`}>
                    <Phone aria-hidden="true" /> {t(`emi.service.${s.kind}` as MessageKey)}: <Ltr>{s.number}</Ltr>
                  </a>
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-base">{t("emi.dialNote")}</p>
          {!data.reviewed && <p role="note" className="rounded-xl bg-sand p-3 text-base text-sand-foreground">{t("emi.devUnreviewed")}</p>}
          <details className="text-base">
            <summary className="min-h-11 cursor-pointer font-semibold">{t("emi.about")}</summary>
            <div className="mt-2 space-y-2">
              <p>{data.reviewed ? t("emi.reviewedBy", { name: data.reviewedBy ?? "" }) : t("emi.notReviewed")}</p>
              <ul className="list-disc space-y-1 ps-6">
                {data.sources.map((src) => <li key={src.url}><a href={src.url} className="underline" target="_blank" rel="noreferrer noopener">{src.title}</a> ({t("emi.checked", { date: src.checkedOn })})</li>)}
              </ul>
              <ul className="list-disc space-y-1 ps-6 text-muted-foreground">{data.caveats.map((c) => <li key={c}>{t(c as MessageKey)}</li>)}</ul>
            </div>
          </details>
        </section>
      )}
    </div>
  );
}
