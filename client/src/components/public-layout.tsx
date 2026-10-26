import { Link } from "wouter";
import { Phone } from "lucide-react";
import { useEmergency } from "@/lib/emergency";
import { useI18n } from "@/lib/i18n";
import { useAppConfig } from "@/hooks/use-app-config";
import Logo from "@/components/logo";
import LanguageSwitcher from "@/components/language-switcher";
import { Ltr } from "@/components/ltr";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Frame for every screen a person can see before signing in. Emergency
 * guidance is on all of them: nobody should have to create an account, or
 * remember a password, to be told to call for help.
 */
export default function PublicLayout({ children, narrow = false, wide = false }: { children: React.ReactNode; narrow?: boolean; wide?: boolean }) {
  const { t } = useI18n();
  const emergency = useEmergency();
  const config = useAppConfig();
  const contact = config?.support;
  const hasContact = !!(contact?.phone || contact?.email);

  const footerLink = "inline-flex min-h-11 items-center text-base text-foreground underline-offset-4 hover:text-primary hover:underline";
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
      >
        {t("skip")}
      </a>
      <div className="bg-destructive text-destructive-foreground">
        <p className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center font-medium">
          {t("emergency.question")}
          {emergency.tel ? (
            <a href={emergency.tel} className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 font-bold underline">
              <Phone className="h-5 w-5" aria-hidden="true" /> {t("emergency.call", { number: emergency.label })}
            </a>
          ) : null}
          <Link href="/emergency" className="inline-flex min-h-11 items-center rounded-md px-2 font-bold underline">
            {emergency.needsCountry ? t("emergency.choose") : t("emi.title")}
          </Link>
        </p>
      </div>
      <header className="border-b border-border bg-card/95">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
          <Logo />
          <nav aria-label={t("public.nav")} className="order-3 flex w-full items-center justify-center gap-1 sm:order-none sm:w-auto sm:flex-1 sm:justify-center">
            <Link href="/find-doctors" className="inline-flex min-h-11 items-center rounded-lg px-3 text-base font-semibold hover:bg-secondary">{t("public.nav.find")}</Link>
            <Link href="/join/doctor" className="inline-flex min-h-11 items-center rounded-lg px-3 text-base font-semibold hover:bg-secondary">{t("public.nav.doctors")}</Link>
            <Link href="/help" className="inline-flex min-h-11 items-center rounded-lg px-3 text-base font-semibold hover:bg-secondary">{t("public.nav.help")}</Link>
          </nav>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button asChild size="sm"><Link href="/login">{t("public.signIn")}</Link></Button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={cn("mx-auto w-full flex-1 px-4 py-8 outline-none", wide ? "max-w-6xl" : narrow ? "max-w-md" : "max-w-3xl")}>
        {children}
      </main>
      <footer className="border-t border-border bg-card">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-3">
            <Logo />
            <p className="max-w-xs text-muted-foreground">{t("public.footer")}</p>
          </div>
          <nav aria-label={t("public.footer.patients")}>
            <h2 className="mb-1 text-base font-semibold">{t("public.footer.patients")}</h2>
            <ul>
              <li><Link href="/find-doctors" className={footerLink}>{t("public.nav.find")}</Link></li>
              <li><Link href="/signup" className={footerLink}>{t("public.footer.createAccount")}</Link></li>
              <li><Link href="/login" className={footerLink}>{t("public.signIn")}</Link></li>
            </ul>
          </nav>
          <nav aria-label={t("public.footer.doctors")}>
            <h2 className="mb-1 text-base font-semibold">{t("public.footer.doctors")}</h2>
            <ul>
              <li><Link href="/join/doctor" className={footerLink}>{t("public.doctorLink")}</Link></li>
              <li><Link href="/login" className={footerLink}>{t("public.footer.doctorSignIn")}</Link></li>
            </ul>
          </nav>
          <nav aria-label={t("public.footer.about")}>
            <h2 className="mb-1 text-base font-semibold">{t("public.footer.about")}</h2>
            <ul>
              <li><Link href="/about" className={footerLink}>{t("public.footer.aboutLink")}</Link></li>
              <li><Link href="/help" className={footerLink}>{t("public.nav.help")}</Link></li>
              <li><Link href="/privacy" className={footerLink}>{t("public.footer.privacy")}</Link></li>
              <li><Link href="/terms" className={footerLink}>{t("public.footer.terms")}</Link></li>
            </ul>
          </nav>
        </div>
        <div className="border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 text-muted-foreground">
            <LanguageSwitcher />
            {hasContact && (
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                {contact?.phone && <Ltr>{contact.phone}</Ltr>}
                {contact?.email && <Ltr>{contact.email}</Ltr>}
              </p>
            )}
            <p>{t("public.footer.notEmergency")}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
