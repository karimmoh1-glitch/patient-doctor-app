import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
  return (
    <Card>
      <CardHeader>
        <CardTitle>{match.name}</CardTitle>
        <CardDescription>
          {match.specialty} · {match.state}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {match.bio && <p className="text-sm text-muted-foreground">{match.bio}</p>}
        {match.matchedKeywords.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-muted-foreground">Matched on:</span>
            {match.matchedKeywords.map((k) => (
              <Badge key={k} variant="outline">
                {k}
              </Badge>
            ))}
          </div>
        )}
        <Button size="sm" onClick={onRequest} disabled={requesting || requested}>
          {requesting ? "Requesting…" : requested ? "Requested" : "Request to connect"}
        </Button>
      </CardContent>
    </Card>
  );
}
