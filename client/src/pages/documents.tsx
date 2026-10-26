import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Upload, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import ConfirmAction from "@/components/confirm-action";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest, SESSION_EXPIRED_EVENT } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";
import { useAppConfig } from "@/hooks/use-app-config";
import { CLIENT_HEADERS } from "@/lib/session";
import { useI18n, type MessageKey } from "@/lib/i18n";

interface Document {
  id: string;
  title: string;
  category: string;
  fileName: string | null;
  hasFile: boolean;
  createdAt: string;
}

// The stored value is what the server keeps; only the label is translated.
const CATEGORIES: { value: string; labelKey: MessageKey }[] = [
  { value: "Lab Result", labelKey: "docs.category.lab_result" },
  { value: "Imaging", labelKey: "docs.category.imaging" },
  { value: "Visit Summary", labelKey: "docs.category.visit_summary" },
  { value: "Insurance", labelKey: "docs.category.insurance" },
  { value: "Other", labelKey: "docs.category.other" },
];

const authHeaders = () => CLIENT_HEADERS;

export default function Documents() {
  const { toast } = useToast();
  const { t } = useI18n();
  const categoryLabel = (value: string) => {
    const known = CATEGORIES.find((c) => c.value === value);
    return known ? t(known.labelKey) : value;
  };
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const config = useAppConfig();
  const canUploadFiles = config?.features.documentUploads ?? false;
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Other");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery<Document[]>({ queryKey: ["/api/documents"] });

  // A plain link can't carry the sign-in header, so the file is fetched with
  // it and opened from memory.
  async function viewFile(id: string) {
    try {
      const res = await fetch(`/api/documents/${id}/file`, { headers: authHeaders() });
      if (res.status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      if (!res.ok) throw new Error(t("docs.error.fileOpen"));
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (err: any) {
      toast({ title: t("docs.toast.openFailed"), description: err.message, variant: "destructive" });
    }
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError(t("docs.error.noName"));
    setUploading(true);
    try {
      const form = new FormData();
      form.append("title", title.trim());
      form.append("category", category);
      const file = fileInputRef.current?.files?.[0];
      if (file) form.append("file", file);
      const res = await fetch("/api/documents", { method: "POST", headers: authHeaders(), body: form });
      if (res.status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || t("docs.error.saveFailed"));
      }
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      setTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      toast({ title: t("docs.toast.saved") });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    try {
      await apiRequest("DELETE", `/api/documents/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      toast({ title: t("docs.toast.deleted") });
    } catch (err: any) {
      toast({ title: t("docs.toast.deleteFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">{t("docs.title")}</h1>
        <p className="text-lg text-muted-foreground">{t("docs.intro")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{t("docs.add.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={upload} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="doc-title" className="text-base">{t("docs.add.nameLabel")}</Label>
              <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("docs.add.namePlaceholder")} aria-describedby={error ? "doc-error" : undefined} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="doc-category" className="text-base">{t("docs.add.categoryLabel")}</Label>
              <NativeSelect id="doc-category" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{t(c.labelKey)}</option>)}
              </NativeSelect>
            </div>
            {canUploadFiles ? (
              <div className="space-y-2">
                <Label htmlFor="doc-file" className="text-base">{t("docs.add.fileLabel")}</Label>
                <Input id="doc-file" ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt" className="h-auto py-3" aria-describedby="doc-file-help" />
                <p id="doc-file-help" className="text-muted-foreground">{t("docs.add.fileHelp")}</p>
              </div>
            ) : (
              <p className="rounded-lg border-2 border-input p-3 text-muted-foreground">{t("docs.add.noUpload")}</p>
            )}
            {error && <p id="doc-error" role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
            <Button type="submit" size="lg" disabled={uploading}>
              <Upload aria-hidden="true" /> {uploading ? t("common.saving") : t("docs.add.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <section aria-labelledby="saved-heading" className="space-y-4">
        <h2 id="saved-heading" className="text-2xl font-semibold">{t("docs.saved.heading")}</h2>
        <QueryState
          query={query}
          isEmpty={(d) => d.length === 0}
          empty={<EmptyBlock title={t("docs.saved.empty")} />}
        >
          {(docs) => (
            <ul className="space-y-4">
              {docs.map((d) => (
                <li key={d.id}>
                  <Card>
                    <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                      <FileText className="mt-1 h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
                      <div className="min-w-0">
                        <CardTitle as="h3" className="text-xl leading-snug">{d.title}</CardTitle>
                        <CardDescription className="text-base">{t("docs.saved.meta", { category: categoryLabel(d.category), date: formatDate(d.createdAt) })}</CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-3">
                      {d.hasFile && <Button variant="outline" onClick={() => viewFile(d.id)}>{t("docs.open")}<span className="sr-only">{t("health.srTitle", { title: d.title })}</span></Button>}
                      <ConfirmAction
                        trigger={<Button variant="outline"><Trash2 aria-hidden="true" /> {t("common.delete")}<span className="sr-only">{t("health.srTitle", { title: d.title })}</span></Button>}
                        title={t("docs.delete.title", { title: d.title })}
                        description={t("docs.delete.body")}
                        confirmLabel={t("docs.delete.confirm")}
                        cancelLabel={t("docs.delete.keep")}
                        destructive
                        onConfirm={() => remove(d.id)}
                      />
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </section>
    </div>
  );
}
