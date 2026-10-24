import { Link } from "wouter";
import { Phone, Stethoscope } from "lucide-react";
import { EMERGENCY_NUMBER, EMERGENCY_TEL } from "@/lib/emergency";
import { useI18n } from "@/lib/i18n";
import { useAppConfig } from "@/hooks/use-app-config";

/**
 * Frame for every screen a person can see before signing in. Emergency
 * guidance is on all of them: nobody should have to create an account, or
 * remember a password, to be told to call for help.
 */
export default function PublicLayout({ children, narrow = false }: { children: React.ReactNode; narrow?: boolean }) {
  const { t } = useI18n();
  const config = useAppConfig();
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
      >
        {t("skip")}
      </a>
      <div className="bg-destructive text-destructive-foreground">
        <p className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center font-medium">
          {t("emergency.question")}
          <a href={EMERGENCY_TEL} className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 font-bold underline">
            <Phone className="h-5 w-5" aria-hidden="true" /> {t("emergency.call", { number: EMERGENCY_NUMBER })}
          </a>
        </p>
      </div>
      {config?.demoMode && (
        <p role="note" className="bg-secondary px-4 py-2 text-center text-base font-medium">{t("demo.banner")}</p>
      )}
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center px-4 py-3">
          <Link href="/" className="flex min-h-12 items-center gap-2 text-xl font-semibold text-primary">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Stethoscope className="h-5 w-5" aria-hidden="true" />
            </span>
            Avela
          </Link>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={`mx-auto w-full flex-1 px-4 py-8 outline-none ${narrow ? "max-w-md" : "max-w-3xl"}`}>
        {children}
      </main>
      <footer className="border-t border-border bg-card px-4 py-6 text-center text-muted-foreground">
        <p className="mx-auto max-w-xl">
          {t("public.footer")}
        </p>
        <p className="mt-3">
          <Link href="/apply-as-doctor" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">
            {t("public.doctorLink")}
          </Link>
        </p>
      </footer>
    </div>
  );
}
