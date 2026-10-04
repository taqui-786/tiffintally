import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check, CookingPot, Menu, ShieldCheck } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { LandingStory } from "@/components/landing/landing-story";
import { LandingHero } from "@/components/landing/landing-hero";
import { ReviewDemo } from "@/components/landing/review-demo";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "TiffinTally · More cooking. Less chasing.",
  description: "Turn customer messages into reviewed packing plans, dated monthly statements, and building-by-building delivery handovers. Built for independent tiffin kitchens.",
  openGraph: {
    title: "TiffinTally · More cooking. Less chasing.",
    description: "Reviewed meal plans. Dated monthly statements. Clear delivery handovers.",
    type: "website",
  },
};

const navigation = [
  { label: "How it works", href: "#workflow" },
  { label: "For your kitchen", href: "#benefits" },
  { label: "Billing & delivery", href: "#billing-delivery" },
  { label: "Questions", href: "#questions" },
];

const linkMotion = "transition-[color,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-safe:active:scale-[0.96] motion-reduce:transition-none";
const focus = "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background";

export default function LandingPage() {
  return (
    <div className="min-h-dvh min-w-0 bg-background text-foreground">
      <a href="#main-content" className="sr-only fixed left-5 top-5 z-20 rounded-xl bg-background p-4 text-foreground shadow-sm focus:not-sr-only">Skip to content</a>
      <header className="relative z-10 px-5 pt-5 sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 border-b py-3">
          <Link href="/" aria-label="TiffinTally home" className={cn("flex min-h-11 items-center gap-2.5", focus)}>
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground"><CookingPot strokeWidth={1.5} className="size-5" aria-hidden="true" /></span>
            <span className="font-heading text-lg font-semibold tracking-tight sm:text-xl">TiffinTally<span className="text-primary">.</span></span>
          </Link>
          <nav aria-label="Main navigation" className="hidden items-center gap-7 xl:flex">
            {navigation.map(({ href, label }) => <a key={href} href={href} className={cn("inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground", linkMotion, focus)}>{label}</a>)}
          </nav>
          <div className="flex items-center gap-2 sm:gap-4">
            <Link href="/signin" className={cn("hidden min-h-11 items-center px-2 text-sm font-medium sm:inline-flex", focus, linkMotion)}>Sign in</Link>
            <Link href="/signin" className={cn(buttonVariants(), "hidden min-h-11 px-4 sm:inline-flex", linkMotion)}>Set up workspace<ArrowRight strokeWidth={1.5} data-icon="inline-end" aria-hidden="true" /></Link>
            <details className="group relative shrink-0 xl:hidden">
              <summary aria-label="Navigation menu" className={cn("flex size-11 cursor-pointer list-none items-center justify-center [&::-webkit-details-marker]:hidden", focus)}><Menu strokeWidth={1.5} className="size-5" aria-hidden="true" /></summary>
              <nav aria-label="Mobile navigation" className="absolute right-0 top-14 flex max-h-[calc(100dvh-6rem)] w-56 max-w-[calc(100vw-2.5rem)] flex-col overflow-y-auto rounded-2xl border bg-popover p-2 text-popover-foreground shadow-sm">
                {navigation.map(({ href, label }) => <a key={href} href={href} className={cn("flex min-h-11 items-center px-3 text-sm hover:bg-muted", focus)}>{label}</a>)}
                <Link href="/signin" className={cn("flex min-h-11 items-center px-3 text-sm hover:bg-muted sm:hidden", focus)}>Sign in</Link>
              </nav>
            </details>
          </div>
        </div>
      </header>

      <main id="main-content">
        <LandingHero />

        <div className="px-5 sm:px-8">
          <div className="mx-auto max-w-7xl"><Separator /><ul aria-label="How TiffinTally helps" className="flex flex-col justify-between gap-5 py-7 text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-6">
            {["Your regulars, organised", "Every change, reviewed by you", "One approved packing plan"].map((item) => <li key={item} className="flex items-center gap-3"><Check strokeWidth={1.5} className="size-4 shrink-0 text-primary" aria-hidden="true" />{item}</li>)}
          </ul><Separator /></div>
        </div>

        <section id="workflow" aria-labelledby="workflow-heading" className="scroll-mt-8 px-5 py-20 sm:px-8 lg:py-28">
          <div className="mx-auto max-w-7xl">
            <h2 id="workflow-heading" className="max-w-3xl font-heading text-4xl leading-[1.1] tracking-[-0.04em] text-balance sm:text-5xl lg:text-6xl">A chat becomes a plan.<br /><span className="text-muted-foreground">Not another thing to chase.</span></h2>
            <p className="mt-6 max-w-lg text-base leading-relaxed text-muted-foreground">Connect your phone once. Your customers keep chatting; your kitchen gets a clearer order desk.</p>
            <ol className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-10">
              {[
                { title: "Connect", text: "Scan a QR code from Linked Devices on your kitchen phone." },
                { title: "Choose", text: "Link your customer contacts once. They keep ordering in their usual chat." },
                { title: "Let orders arrive", text: "Text orders arrive automatically. With AI configured, meal changes become review drafts." },
                { title: "Check, then pack", text: "Approve the right customer, date, and quantity. Finalise one clear packing sheet." },
              ].map(({ title, text }, index) => <li key={title} className="flex min-w-0 flex-col gap-5 border-t border-dashed pt-5"><span className="font-heading text-5xl font-medium leading-none tracking-tighter tabular-nums text-primary/65" aria-hidden="true">0{index + 1}</span><div><h3 className="font-heading text-xl tracking-tight">{title}</h3><p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">{text}</p></div></li>)}
            </ol>
          </div>
        </section>

        <section aria-labelledby="try-heading" className="bg-muted/35 px-5 py-20 sm:px-8 lg:py-24">
          <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-20">
            <div className="min-w-0 lg:col-start-2 lg:row-start-1"><h2 id="try-heading" className="font-heading text-4xl leading-[1.1] tracking-[-0.04em] text-balance sm:text-5xl">A tiny message.<br />A real difference.</h2><p className="mt-6 max-w-sm text-base leading-relaxed text-muted-foreground">“Skip today.” “Send two extra.” Try a fictional request and watch the sample total change only after you approve it.</p><p className="mt-8 flex items-center gap-2 text-sm font-medium"><ShieldCheck strokeWidth={1.5} className="size-5 shrink-0 text-primary" aria-hidden="true" />AI can suggest. Only you can approve.</p></div>
            <div className="relative min-w-0 lg:col-start-1 lg:row-start-1"><div aria-hidden="true" className="pointer-events-none absolute -inset-2 overflow-hidden"><div className="absolute inset-0 border border-dashed border-primary/20 md:rotate-[-2deg]" /></div><div className="relative flex min-w-0 justify-center"><ReviewDemo /></div></div>
          </div>
        </section>

        <LandingStory />
      </main>
    </div>
  );
}
