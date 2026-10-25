import PublicLayout from "@/components/public-layout";
import PageHeader from "@/components/page-header";
import { useI18n, type MessageKey } from "@/lib/i18n";

type Page = "about" | "privacy" | "terms";

const SECTIONS: Record<Page, number> = { about: 3, privacy: 6, terms: 6 };

/**
 * Plain-language pages about what Avela is and how it treats information.
 * They are written to be read by anyone, and they say clearly that they are a
 * draft that needs legal review: they are not a legal agreement.
 */
export default function LegalPage({ page }: { page: Page }) {
  const { t } = useI18n();
  const sections = Array.from({ length: SECTIONS[page] }, (_, i) => i + 1);
  return (
    <PublicLayout>
      <article className="space-y-8">
        <PageHeader title={t(`legal.${page}.title` as MessageKey)} description={t(`legal.${page}.intro` as MessageKey)} />
        {page !== "about" && <p role="note" className="rounded-2xl bg-sand p-4 text-base text-sand-foreground">{t("legal.draftNote")}</p>}
        {sections.map((n) => (
          <section key={n} aria-labelledby={`${page}-${n}`} className="space-y-2">
            <h2 id={`${page}-${n}`} className="font-display text-2xl font-semibold">{t(`legal.${page}.s${n}.title` as MessageKey)}</h2>
            <p className="text-lg">{t(`legal.${page}.s${n}.body` as MessageKey)}</p>
          </section>
        ))}
      </article>
    </PublicLayout>
  );
}
