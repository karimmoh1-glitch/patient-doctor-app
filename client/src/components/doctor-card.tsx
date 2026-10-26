import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { specialtyLabel } from "@/lib/labels";

export interface DoctorMatch {
  doctorProfileId: string;
  name: string;
  specialty: string;
  state: string;
  bio: string | null;
  matchedKeywords: string[];
}

export default function DoctorCard({
  match,
  onRequest,
  requesting,
  requested,
}: {
  match: DoctorMatch;
  onRequest: () => void;
  requesting: boolean;
  requested: boolean;
}) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{match.name}</CardTitle>
        <CardDescription className="text-base">
          {t("pt.dcard.licensed", { specialty: specialtyLabel(t, match.specialty), state: match.state })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {match.bio && <p className="text-base">{match.bio}</p>}
        <p className="text-muted-foreground">{t("pt.dcard.sameState", { state: match.state })}</p>
        {match.matchedKeywords.length > 0 && (
          <p className="text-muted-foreground">
            {t("pt.dcard.shown", { words: match.matchedKeywords.map((k) => `"${k}"`).join(t("pt.listSep")) })}
          </p>
        )}
        <div>
          <Button size="lg" onClick={onRequest} disabled={requesting || requested}>
            {requesting ? t("pt.sending") : requested ? t("pt.requestSent") : t("pt.dcard.ask")}
          </Button>
          {requested && (
            <p role="status" className="mt-2 text-muted-foreground">
              {t("pt.dcard.requestedBody")}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
