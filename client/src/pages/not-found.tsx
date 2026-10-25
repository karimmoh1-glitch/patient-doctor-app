import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <h1 className="text-3xl font-semibold">{t("notfound.title")}</h1>
      <p className="text-muted-foreground">{t("notfound.body")}</p>
      <Link href="/">
        <Button>{t("notfound.home")}</Button>
      </Link>
    </div>
  );
}
