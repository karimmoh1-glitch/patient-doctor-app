import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface DoctorMatch {
  doctorProfileId: string;
  isDemoProfile?: boolean;
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{match.name}</CardTitle>
        <CardDescription className="text-base">
          {match.specialty} · licensed in {match.state}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {match.bio && <p className="text-base">{match.bio}</p>}
        {match.matchedKeywords.length > 0 && (
          <p className="text-muted-foreground">
            Shown because you wrote: {match.matchedKeywords.map((k) => `"${k}"`).join(", ")}
          </p>
        )}
        {match.isDemoProfile && (
          <Badge variant="outline">Demonstration profile — this doctor will not reply</Badge>
        )}
        <div>
          <Button size="lg" onClick={onRequest} disabled={requesting || requested}>
            {requesting ? "Sending…" : requested ? "Request sent" : "Ask this doctor to see me"}
          </Button>
          {requested && (
            <p role="status" className="mt-2 text-muted-foreground">
              The doctor will see your request and what you wrote. They decide whether to accept; it can take a day or more.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
