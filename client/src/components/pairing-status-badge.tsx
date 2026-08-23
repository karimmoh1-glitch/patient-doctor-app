import { Badge } from "@/components/ui/badge";

const VARIANTS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  requested: { label: "Pending", variant: "secondary" },
  accepted: { label: "Connected", variant: "default" },
  declined: { label: "Declined", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

export default function PairingStatusBadge({ status }: { status: string }) {
  const config = VARIANTS[status] || { label: status, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
