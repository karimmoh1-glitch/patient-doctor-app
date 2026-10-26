import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import PageHeader from "@/components/page-header";
import QueryState from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ConfirmAction from "@/components/confirm-action";
import { Ltr } from "@/components/ltr";
import { apiRequest } from "@/lib/queryClient";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDateTime } from "@/lib/format";

interface Created { id: string; code: string; url: string; expiresAt: string }
interface Row { id: string; state: "pending" | "accepted" | "expired" | "revoked"; createdAt: string; expiresAt: string; acceptedAt: string | null; patientName: string | null }

function Countdown({ until }: { until: string }) {
  const { t } = useI18n();
  const [left, setLeft] = useState(() => Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 1000)));
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 1000))), 1000);
    return () => clearInterval(id);
  }, [until]);
  if (left === 0) return <p role="status" className="text-lg font-semibold text-destructive">{t("dconn.expired")}</p>;
  return <p className="text-lg">{t("dconn.expiresIn", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` })}</p>;
}

export default function DoctorConnect() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<Created | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useQuery<Row[]>({ queryKey: ["/api/pairing-invitations"], staleTime: 0, refetchInterval: 4000 });

  async function make() {
    setBusy(true);
    setError(null);
    setQr(null);
    setQrFailed(false);
    try {
      const res = await apiRequest("POST", "/api/pairing-invitations");
      const c = (await res.json()) as Created;
      setCreated(c);
      QRCode.toDataURL(c.url, { margin: 2, width: 288, errorCorrectionLevel: "M" }).then(setQr, () => setQrFailed(true));
      queryClient.invalidateQueries({ queryKey: ["/api/pairing-invitations"] });
    } catch (err: any) {
      setError(err.message || t("dconn.failed"));
    } finally {
      setBusy(false);
    }
  }

  // The patient's confirmation is what makes the connection, so the screen follows the server: it says "connected" only when the
  // list reports the code accepted.
  const mine = created ? list.data?.find((r) => r.id === created.id) : undefined;
  const state = mine?.state ?? (created ? "pending" : null);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t("dconn.title")} description={t("dconn.intro")} />
      <div className="space-y-3">
        <Button size="lg" onClick={make} disabled={busy}>{busy ? t("common.saving") : created ? t("dconn.makeAnother") : t("dconn.make")}</Button>
        {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error} <Button variant="outline" onClick={make}>{t("common.retry")}</Button></p>}
      </div>
      {created && (
        <section aria-labelledby="dc-code" className="space-y-4 rounded-2xl border-2 border-input bg-card p-5 text-center">
          <h2 id="dc-code" className="font-display text-2xl">{t("dconn.show")}</h2>
          {state === "accepted" ? (
            <p role="status" className="text-2xl font-semibold text-primary">{t("dconn.connected", { name: mine?.patientName ?? "" })}</p>
          ) : state === "pending" ? (
            <>
              {qr ? <img src={qr} alt={t("dconn.qr.alt")} width={288} height={288} className="mx-auto rounded-xl border-2 border-input bg-white" /> : qrFailed ? <p role="alert" className="font-medium text-destructive">{t("dconn.qr.failed")}</p> : <p role="status">{t("dconn.qr.loading")}</p>}
              <div>
                <p className="text-base text-muted-foreground">{t("dconn.orType")}</p>
                <p className="text-4xl font-bold tracking-widest"><Ltr>{created.code}</Ltr></p>
              </div>
              <Countdown until={created.expiresAt} />
              <p className="text-base text-muted-foreground">{t("dconn.waiting")}</p>
              <ConfirmAction
                trigger={<Button variant="outline">{t("dconn.revoke")}</Button>}
                title={t("dconn.revoke.title")} description={t("dconn.revoke.body")} confirmLabel={t("dconn.revoke.yes")} cancelLabel={t("common.cancel")}
                onConfirm={async () => { await apiRequest("DELETE", `/api/pairing-invitations/${created.id}`); queryClient.invalidateQueries({ queryKey: ["/api/pairing-invitations"] }); }}
              />
            </>
          ) : (
            <p role="status" className="text-xl">{t(`dconn.state.${state}` as MessageKey)}</p>
          )}
        </section>
      )}
      <section aria-labelledby="dc-list" className="space-y-3">
        <h2 id="dc-list" className="font-display text-2xl">{t("dconn.history")}</h2>
        <QueryState query={list} loadingLabel={t("hp.loading")} isEmpty={(d) => d.length === 0} empty={<p className="text-lg text-muted-foreground">{t("dconn.none")}</p>}>
          {(rows) => (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3 text-lg">
                  <span>{formatDateTime(r.createdAt)}{r.state === "accepted" && r.patientName ? ` · ${r.patientName}` : ""}</span>
                  <Badge variant={r.state === "accepted" ? "default" : "secondary"}>{t(`dconn.state.${r.state}` as MessageKey)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </section>
      <p className="text-base text-muted-foreground">{t("dconn.note")}</p>
    </div>
  );
}
