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
import { useI18n, type MessageKey } from "@/lib/i18n";

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
const STEP_LABELS: Record<string, MessageKey> = {
  received: "pharmacy.step.received",
  processing: "pharmacy.step.processing",
  preparing: "pharmacy.step.preparing",
  ready_for_pickup: "pharmacy.step.ready_for_pickup",
  out_for_delivery: "status.pharmacyOrder.out_for_delivery",
  delivered: "status.pharmacyOrder.delivered",
  picked_up: "pharmacy.step.picked_up",
};
// The choices come from the server in English; known ones are shown in the reader's language.
const OPTION_LABELS: Record<string, MessageKey> = {
  "Home Delivery": "pharmacy.opt.home",
  "Mail-Order Delivery": "pharmacy.opt.mail",
  Pickup: "pharmacy.opt.pickup",
};

function DemoBanner() {
  const { t } = useI18n();
  return (
    <p role="note" className="rounded-xl border-2 border-dashed border-input p-4 text-lg">
      <strong>{t("pharmacy.demo.strong")}</strong> {t("pharmacy.demo.rest")}
    </p>
  );
}

function OrderTracker({ order }: { order: Order }) {
  const { t } = useI18n();
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
      toast({ title: t("pharmacy.toast.updateFailed"), description: err.message, variant: "destructive" });
    } finally {
      setAdvancing(false);
    }
  }

  return (
    <li>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="min-w-0">
            <CardTitle as="h3" className="text-xl">{order.medicationName}</CardTitle>
            <CardDescription className="text-base">
              {t(order.fulfillmentType === "delivery" ? "pharmacy.order.metaDelivery" : "pharmacy.order.metaPickup", { pharmacy: order.pharmacy?.name ?? "" })}
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
                  {STEP_LABELS[step] ? t(STEP_LABELS[step]) : step}
                  <span className="sr-only"> {i < current ? t("pharmacy.step.done") : i === current ? t("pharmacy.step.current") : t("pharmacy.step.notYet")}</span>
                </span>
              </li>
            ))}
          </ol>
          {!isFinal && (
            <Button variant="outline" disabled={advancing} onClick={advance}>
              {t("pharmacy.advance")}
            </Button>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

function NotAvailable() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-3xl font-semibold">{t("pharmacy.title")}</h1>
      <EmptyBlock title={t("pharmacy.unavailable.title")}>
        {t("pharmacy.unavailable.body")}
      </EmptyBlock>
    </div>
  );
}

export default function Pharmacy() {
  const config = useAppConfig();
  const { t } = useI18n();
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
    if (!prescriptionId) return setError(t("pharmacy.error.medicine"));
    if (!chosen) return setError(t("pharmacy.error.method"));
    if (chosen.fulfillmentType === "delivery" && !address.trim()) return setError(t("pharmacy.error.address"));
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/pharmacy/orders", {
        prescriptionId, pharmacyId: chosen.pharmacyId, fulfillmentType: chosen.fulfillmentType,
        deliveryAddress: chosen.fulfillmentType === "delivery" ? address.trim() : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/pharmacy/orders"] });
      toast({ title: t("pharmacy.toast.created"), description: t("pharmacy.toast.createdBody") });
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
        <h1 className="text-3xl font-semibold">{t("pharmacy.title")}</h1>
        <DemoBanner />
      </div>

      {orderable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{t("pharmacy.try.title")}</CardTitle>
            <CardDescription className="text-base">{t("pharmacy.try.intro")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="rx" className="text-base">{t("pharmacy.try.which")}</Label>
              <NativeSelect id="rx" value={prescriptionId} onChange={(e) => { setPrescriptionId(e.target.value); setChosen(null); }}>
                <option value="">{t("pharmacy.try.choose")}</option>
                {orderable.map((p) => <option key={p.id} value={p.id}>{p.medicationName}</option>)}
              </NativeSelect>
            </div>

            {prescriptionId && (
              <fieldset className="space-y-3">
                <legend className="mb-2 text-base font-semibold">{t("pharmacy.try.how")}</legend>
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
                      <span className="min-w-0">
                        <span className="block text-lg font-semibold">{OPTION_LABELS[opt.label] ? t(OPTION_LABELS[opt.label]) : opt.label}</span>
                        <span className="block text-muted-foreground">{opt.distanceMiles !== null ? t("pharmacy.opt.distance", { pharmacy: opt.pharmacyName, distance: opt.distanceMiles }) : opt.pharmacyName}</span>
                        <span className="block">{opt.etaText} · {opt.feeText} <em>{t("pharmacy.example")}</em></span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}

            {chosen?.fulfillmentType === "delivery" && (
              <div className="space-y-2">
                <Label htmlFor="addr" className="text-base">{t("pharmacy.try.address")}</Label>
                <Textarea id="addr" value={address} onChange={(e) => setAddress(e.target.value)} rows={3} autoComplete="street-address" />
              </div>
            )}

            {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
            {chosen && <Button size="lg" disabled={submitting} onClick={submit}>{t("pharmacy.try.create")}</Button>}
          </CardContent>
        </Card>
      )}

      <section aria-labelledby="orders-heading" className="space-y-3">
        <h2 id="orders-heading" className="text-2xl font-semibold">{t("pharmacy.orders.heading")}</h2>
        <QueryState
          query={orders}
          isEmpty={(o) => o.length === 0}
          empty={<EmptyBlock title={t("pharmacy.orders.empty")} />}
        >
          {(list) => <ul className="space-y-4">{list.map((o) => <OrderTracker key={o.id} order={o} />)}</ul>}
        </QueryState>
      </section>
    </div>
  );
}
