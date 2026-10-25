/**
 * Wraps content that must always read left-to-right even inside Arabic text:
 * phone numbers, email addresses, dosages like "500 mg", URLs. Without it the
 * punctuation and plus signs of such text jump to the wrong side in RTL.
 */
export function Ltr({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={`ltr-isolate ${className ?? ""}`}>
      {children}
    </bdi>
  );
}
