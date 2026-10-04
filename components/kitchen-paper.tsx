import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Flat notebook sections for the customer book and kitchen house rules. */
export function KitchenPaper({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("flex min-w-0 flex-col gap-6 border-t py-6 first:border-t-0 first:pt-0", className)} {...props} />;
}
export function KitchenPaperHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid min-w-0 grid-cols-1 items-start gap-x-5 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]", className)} {...props} />;
}
export function KitchenPaperTitle({ children, className, ...props }: ComponentProps<"h2">) {
  const label: { index: string; title: ReactNode } | null = children === "Customers" ? { index: "01 / CUSTOMER BOOK", title: "Your regulars" } : children === "Planning settings" ? { index: "01 / KITCHEN HOUSE RULES", title: "A rhythm that works for you." } : null;
  return <div className="col-start-1 min-w-0 [overflow-wrap:anywhere]">{label ? <p className="mb-3 font-mono text-[10px] tracking-[0.15em] text-muted-foreground">{label.index}</p> : null}<h2 className={cn("font-heading text-xl tracking-tight", label && "text-2xl", className)} {...props}>{label?.title ?? children}</h2></div>;
}
export function KitchenPaperDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("col-start-1 min-w-0 max-w-xl text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]", className)} {...props} />;
}
export function KitchenPaperAction({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("col-start-1 min-w-0 max-w-full self-start sm:col-start-2 sm:row-start-1 [&_button]:max-w-full", className)} {...props} />;
}
export function KitchenPaperContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 [overflow-wrap:anywhere] [&_tbody_tr]:align-top [&_tbody_td]:py-4 [&_thead_th]:font-mono [&_thead_th]:text-xs [&_fieldset]:min-w-0 [&_fieldset]:border-t [&_fieldset]:pt-5 [&_[data-slot=field]]:min-w-0 [&_[data-slot=field-group]]:min-w-0 [&_[data-slot=field-label]]:whitespace-normal", className)} {...props} />;
}
