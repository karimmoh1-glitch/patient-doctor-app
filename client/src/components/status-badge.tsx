import { CheckCircle2, Circle, Clock, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useI18n, type MessageKey } from "@/lib/i18n";

type Variant = "default" | "secondary" | "destructive" | "outline";

// Which statuses read as "good / in effect", "waiting", "stopped" or "finished".
// Each badge shows an icon AND text, so colour is never the only signal.
const VARIANTS: Record<string, Record<string, Variant>> = {
  pairing: { requested: "secondary", accepted: "default", declined: "destructive", cancelled: "outline", ended: "outline" },
  appointment: { requested: "secondary", confirmed: "default", completed: "outline", cancelled: "destructive" },
  prescription: { draft: "secondary", active: "default", completed: "outline", expired: "outline", cancelled: "destructive" },
  pharmacyOrder: {
    received: "secondary", processing: "secondary", preparing: "secondary", ready_for_pickup: "default",
    out_for_delivery: "default", delivered: "outline", picked_up: "outline",
  },
  followUp: { open: "secondary", done: "outline" },
};

const ICONS: Record<Variant, typeof Circle> = {
  default: CheckCircle2,
  secondary: Clock,
  destructive: XCircle,
  outline: Circle,
};

export default function StatusBadge({ kind, status }: { kind: keyof typeof VARIANTS; status: string }) {
  const { t } = useI18n();
  const variant = VARIANTS[kind]?.[status] ?? "outline";
  const Icon = ICONS[variant];
  const key = `status.${kind}.${status}` as MessageKey;
  const label = t(key);
  // An unknown status still shows something readable rather than a raw key.
  const text = label === key ? status.replace(/_/g, " ") : label;
  return (
    <Badge variant={variant} className="gap-1.5">
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {text}
    </Badge>
  );
}
