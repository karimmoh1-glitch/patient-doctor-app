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

interface Document {
  id: string;
  title: string;
  category: string;
  fileName: string | null;
  hasFile: boolean;
  createdAt: string;
}

const CATEGORIES = ["Lab Result", "Imaging", "Visit Summary", "Insurance", "Other"];

function authHeaders(): Record<string, string> {
  try {
    const stored = localStorage.getItem("pdapp_auth");
    if (stored) return { Authorization: `Bearer ${JSON.parse(stored).token}` };
  } catch {
    // treated as signed out
  }
  return {};
}

export default function Documents() {
  const { toast } = useToast();
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
      if (!res.ok) throw new Error("The file couldn't be opened.");
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (err: any) {
      toast({ title: "We couldn't open the file", description: err.message, variant: "destructive" });
    }
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Please give this document a name so you can find it later.");
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
        throw new Error(data.message || "The document couldn't be saved.");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      setTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      toast({ title: "Document saved" });
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
      toast({ title: "Document deleted" });
    } catch (err: any) {
      toast({ title: "We couldn't delete it", description: err.message, variant: "destructive" });
      throw err;
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">Documents</h1>
        <p className="text-lg text-muted-foreground">Test results, letters and other papers you want to keep in one place. Only you can see them unless you choose to share.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Add a document</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={upload} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="doc-title" className="text-base">What is it called?</Label>
              <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Blood test results" aria-describedby={error ? "doc-error" : undefined} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="doc-category" className="text-base">What kind of paper is it?</Label>
              <NativeSelect id="doc-category" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </NativeSelect>
            </div>
            {canUploadFiles ? (
              <div className="space-y-2">
                <Label htmlFor="doc-file" className="text-base">The file (optional)</Label>
                <Input id="doc-file" ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt" className="h-auto py-3" aria-describedby="doc-file-help" />
                <p id="doc-file-help" className="text-muted-foreground">A PDF, photo, or text file, up to 10 MB.</p>
              </div>
            ) : (
              <p className="rounded-lg border-2 border-input p-3 text-muted-foreground">Saving the file itself isn't available on this service yet. You can keep a note of what the paper is and where it is.</p>
            )}
            {error && <p id="doc-error" role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
            <Button type="submit" size="lg" disabled={uploading}>
              <Upload aria-hidden="true" /> {uploading ? "Saving…" : "Save this document"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <section aria-labelledby="saved-heading" className="space-y-4">
        <h2 id="saved-heading" className="text-2xl font-semibold">Saved documents</h2>
        <QueryState
          query={query}
          isEmpty={(d) => d.length === 0}
          empty={<EmptyBlock title="You haven't saved any documents yet" />}
        >
          {(docs) => (
            <ul className="space-y-4">
              {docs.map((d) => (
                <li key={d.id}>
                  <Card>
                    <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                      <FileText className="mt-1 h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
                      <div>
                        <CardTitle as="h3" className="text-xl leading-snug">{d.title}</CardTitle>
                        <CardDescription className="text-base">{d.category} · saved {formatDate(d.createdAt)}</CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-3">
                      {d.hasFile && <Button variant="outline" onClick={() => viewFile(d.id)}>Open the file<span className="sr-only">: {d.title}</span></Button>}
                      <ConfirmAction
                        trigger={<Button variant="outline"><Trash2 aria-hidden="true" /> Delete<span className="sr-only">: {d.title}</span></Button>}
                        title={`Delete "${d.title}"?`}
                        description="This removes it from Avela for good. Any doctor you had shared it with will no longer be able to see it. This can't be undone."
                        confirmLabel="Yes, delete it"
                        cancelLabel="No, keep it"
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
