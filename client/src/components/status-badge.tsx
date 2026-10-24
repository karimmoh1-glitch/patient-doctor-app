import { Badge } from "@/components/ui/badge";

type Variant = "default" | "secondary" | "destructive" | "outline";

const CONFIGS: Record<string, Record<string, { label: string; variant: Variant }>> = {
  pairing: {
    requested: { label: "Pending", variant: "secondary" },
    accepted: { label: "Connected", variant: "default" },
    declined: { label: "Declined", variant: "destructive" },
    cancelled: { label: "Cancelled", variant: "outline" },
    ended: { label: "Sharing stopped", variant: "outline" },
  },
  appointment: {
    requested: { label: "Requested", variant: "secondary" },
    confirmed: { label: "Confirmed", variant: "default" },
    completed: { label: "Completed", variant: "outline" },
    cancelled: { label: "Cancelled", variant: "destructive" },
  },
  prescription: {
    active: { label: "Active", variant: "default" },
    completed: { label: "Completed", variant: "outline" },
    cancelled: { label: "Cancelled", variant: "destructive" },
  },
  pharmacyOrder: {
    received: { label: "Received", variant: "secondary" },
    processing: { label: "Processing", variant: "secondary" },
    preparing: { label: "Preparing", variant: "secondary" },
    ready_for_pickup: { label: "Ready for pickup", variant: "default" },
    out_for_delivery: { label: "Out for delivery", variant: "default" },
    delivered: { label: "Delivered", variant: "outline" },
    picked_up: { label: "Picked up", variant: "outline" },
  },
  followUp: {
    open: { label: "Open", variant: "secondary" },
    done: { label: "Done", variant: "outline" },
  },
};

export default function StatusBadge({ kind, status }: { kind: keyof typeof CONFIGS; status: string }) {
  const config = CONFIGS[kind]?.[status] || { label: status.replace(/_/g, " "), variant: "outline" as Variant };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
