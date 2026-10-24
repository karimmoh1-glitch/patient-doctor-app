import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Truck, Store, Mail, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import StatusBadge from "@/components/status-badge";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAppConfig } from "@/hooks/use-app-config";
import { cn } from "@/lib/utils";

interface Prescription { id: string; medicationName: string; status: string }

interface FulfillmentOption {
  pharmacyId: string;
  pharmacyName: string;
  fulfillmentType: "pickup" | "delivery";
  label: string;
  etaText: string;
  feeText: string;
  distanceMiles: number | null;
  badge: string | null;
}

interface Order {
  id: string;
  medicationName: string;
  status: string;
  fulfillmentType: string;
  statusHistory: { status: string; at: string }[];
  pharmacy: { id: string; name: string; address: string } | null;
}

const OPTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "Home Delivery": Truck,
  "Mail-Order Delivery": Mail,
  Pickup: Store,
};

const PICKUP_STEPS = ["received", "processing", "preparing", "ready_for_pickup", "picked_up"];
const DELIVERY_STEPS = ["received", "processing", "preparing", "out_for_delivery", "delivered"];
const STEP_LABELS: Record<string, string> = {
  received: "Order received",
  processing: "Confirmed",
  preparing: "Being prepared",
  ready_for_pickup: "Ready to collect",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  picked_up: "Collected",
};

function DemoBanner() {
  return (
    <p role="note" className="rounded-xl border-2 border-dashed border-input p-4 text-lg">
      <strong>Demonstration only.</strong> Nothing here is ordered, filled or delivered. The times and prices are examples.
    </p>
  );
}

function OrderTracker({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [advancing, setAdvancing] = useState(false);
  const steps = order.fulfillmentType === "delivery" ? DELIVERY_STEPS : PICKUP_STEPS;
  const current = steps.indexOf(order.status);
  const isFinal = current === steps.length - 1;

  async function advance() {
    setAdvancing(true);
    try {
      await apiRequest("POST", `/api/pharmacy/orders/${order.id}/advance`);
      queryClient.invalidateQueries({ queryKey: ["/api/pharmacy/orders"] });
    } catch (err: any) {
      toast({ title: "We couldn't update the order", description: err.message, variant: "destructive" });
    } finally {
      setAdvancing(false);
    }
  }

  return (
    <li>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle as="h3" className="text-xl">{order.medicationName}</CardTitle>
            <CardDescription className="text-base">
              {order.pharmacy?.name} · {order.fulfillmentType === "delivery" ? "Home delivery" : "Collect in person"} (example)
            </CardDescription>
          </div>
          <StatusBadge kind="pharmacyOrder" status={order.status} />
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="space-y-2">
            {steps.map((step, i) => (
              <li key={step} className="flex items-center gap-3 text-lg" aria-current={i === current ? "step" : undefined}>
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2",
                    i <= current ? "border-primary bg-primary text-primary-foreground" : "border-input",
                  )}
                  aria-hidden="true"
                >
                  {i <= current ? <Check className="h-5 w-5" /> : i + 1}
                </span>
                <span className={i === current ? "font-semibold" : "text-muted-foreground"}>
                  {STEP_LABELS[step]}
                  <span className="sr-only">{i < current ? " (done)" : i === current ? " (current)" : " (not yet)"}</span>
                </span>
              </li>
            ))}
          </ol>
          {!isFinal && (
            <Button variant="outline" disabled={advancing} onClick={advance}>
              Move this example order to the next step
            </Button>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

function NotAvailable() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-3xl font-semibold">Pharmacy</h1>
      <EmptyBlock title="Ordering from a pharmacy isn't available yet">
        Please take your prescription to the pharmacy you usually use, or ask your doctor's office how to get it filled.
      </EmptyBlock>
    </div>
  );
}

export default function Pharmacy() {
  const config = useAppConfig();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = new URLSearchParams(window.location.search);
  const [prescriptionId, setPrescriptionId] = useState(params.get("prescription") || "");
  const [chosen, setChosen] = useState<FulfillmentOption | null>(null);
  const [address, setAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prescriptions = useQuery<Prescription[]>({ queryKey: ["/api/prescriptions"], enabled: !!config?.demoMode });
  const options = useQuery<FulfillmentOption[]>({ queryKey: ["/api/pharmacy/fulfillment-options"], enabled: !!config?.demoMode });
  const orders = useQuery<Order[]>({ queryKey: ["/api/pharmacy/orders"], enabled: !!config?.demoMode });

  if (config && !config.demoMode) return <NotAvailable />;

  const orderable = (prescriptions.data || []).filter((p) => p.status === "active" && !(orders.data || []).some((o) => o.medicationName === p.medicationName));

  async function submit() {
    setError(null);
    if (!prescriptionId) return setError("Choose which medicine you want.");
    if (!chosen) return setError("Choose how you would like to get it.");
    if (chosen.fulfillmentType === "delivery" && !address.trim()) return setError("Please enter the address to deliver to.");
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/pharmacy/orders", {
        prescriptionId, pharmacyId: chosen.pharmacyId, fulfillmentType: chosen.fulfillmentType,
        deliveryAddress: chosen.fulfillmentType === "delivery" ? address.trim() : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/pharmacy/orders"] });
      toast({ title: "Example order created", description: "Nothing has really been ordered." });
      setPrescriptionId(""); setChosen(null); setAddress("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold">Pharmacy</h1>
        <DemoBanner />
      </div>

      {orderable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Try ordering a medicine</CardTitle>
            <CardDescription className="text-base">We show a few practical choices, not every pharmacy.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="rx" className="text-base">Which medicine?</Label>
              <NativeSelect id="rx" value={prescriptionId} onChange={(e) => { setPrescriptionId(e.target.value); setChosen(null); }}>
                <option value="">Choose a medicine</option>
                {orderable.map((p) => <option key={p.id} value={p.id}>{p.medicationName}</option>)}
              </NativeSelect>
            </div>

            {prescriptionId && (
              <fieldset className="space-y-3">
                <legend className="mb-2 text-base font-semibold">How would you like to get it?</legend>
                {options.data?.map((opt) => {
                  const Icon = OPTION_ICONS[opt.label] || Truck;
                  const active = chosen?.pharmacyId === opt.pharmacyId && chosen?.fulfillmentType === opt.fulfillmentType;
                  return (
                    <label
                      key={`${opt.pharmacyId}-${opt.fulfillmentType}`}
                      className={cn("flex min-h-20 cursor-pointer items-start gap-4 rounded-xl border-2 p-4", active ? "border-primary bg-secondary" : "border-input bg-card")}
                    >
                      <input type="radio" name="option" className="mt-1 h-6 w-6" checked={active} onChange={() => setChosen(opt)} />
                      <Icon className="mt-1 h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
                      <span>
                        <span className="block text-lg font-semibold">{opt.label}</span>
                        <span className="block text-muted-foreground">{opt.pharmacyName}{opt.distanceMiles !== null ? ` · ${opt.distanceMiles} miles away` : ""}</span>
                        <span className="block">{opt.etaText} · {opt.feeText} <em>(example)</em></span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}

            {chosen?.fulfillmentType === "delivery" && (
              <div className="space-y-2">
                <Label htmlFor="addr" className="text-base">Address to deliver to</Label>
                <Textarea id="addr" value={address} onChange={(e) => setAddress(e.target.value)} rows={3} autoComplete="street-address" />
              </div>
            )}

            {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
            {chosen && <Button size="lg" disabled={submitting} onClick={submit}>Create example order</Button>}
          </CardContent>
        </Card>
      )}

      <section aria-labelledby="orders-heading" className="space-y-3">
        <h2 id="orders-heading" className="text-2xl font-semibold">Example orders</h2>
        <QueryState
          query={orders}
          isEmpty={(o) => o.length === 0}
          empty={<EmptyBlock title="No example orders yet" />}
        >
          {(list) => <ul className="space-y-4">{list.map((o) => <OrderTracker key={o.id} order={o} />)}</ul>}
        </QueryState>
      </section>
    </div>
  );
}
