import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

/**
 * Wraps any trigger button in a plain-language confirmation. The safe choice
 * ("Keep it") is the first, default-focused option and its label says what
 * happens; the consequential one says exactly what it does ("Yes, cancel my
 * appointment"), never just "OK".
 */
export default function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-xl">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-base text-muted-foreground">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-3 sm:gap-3">
          <AlertDialogCancel className={cn(buttonVariants({ variant: "outline" }), "mt-0")}>{cancelLabel ?? t("confirmact.keep")}</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: destructive ? "destructive" : "default" })}
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await onConfirm();
                setOpen(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t("confirmact.working") : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
