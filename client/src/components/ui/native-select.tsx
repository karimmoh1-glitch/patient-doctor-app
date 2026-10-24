import * as React from "react";
import { cn } from "@/lib/utils";

// A real <select>: phones show their own large picker, screen readers and
// keyboards already know how to use it, and it works on old browsers. For a
// short, simple choice (a state, a time zone) it is more dependable than a
// custom dropdown.
const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-12 w-full rounded-md border border-input bg-white px-3 text-base disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
NativeSelect.displayName = "NativeSelect";
export { NativeSelect };
