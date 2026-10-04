import Image from "next/image";
import Link from "next/link";
import { ArrowRight, CalendarDays, ClipboardCheck, CookingPot, PackageCheck, ReceiptText, Route } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const features = [
  {
    icon: CalendarDays,
    layout: "md:col-span-3 md:pr-6 lg:pr-10",
    title: "A routine worth keeping",
    description:
      "Keep recurring customer schedules together. Review today's pauses, extras, and meal changes against the usual plan.",
  },
  {
    icon: ClipboardCheck,
    layout: "bg-muted/50 p-6 md:col-span-5 lg:p-10",
    title: "Your review comes first",
    description:
      "Connected WhatsApp messages arrive automatically. With AI configured, they become drafts; you check the customer, date, and quantity before approving.",
  },
  {
    icon: PackageCheck,
    layout: "md:col-span-4 md:pl-6 lg:pl-10",
    title: "One plan for the kitchen",
    description:
      "Review changes before finalising the packing sheet, then use the approved cooking and packing plan for the day's meals.",
  },
];

const questions = [
  {
    question: "Can I share a monthly bill with dated proof?",
    answer: "Yes. Set an agreed meal price and optional UPI ID, then preview a closed month's finalized packing records. Skips and extras are counted once, with dated sheet and approval references. Half-portion charges are explicit seller-confirmed adjustments. Incomplete months cannot be issued. Issue the statement, then open WhatsApp to review and send it; payment tracking is not included.",
  },
  {
    question: "What does Ramesh Mode do?",
    answer: "Give customers a building or route name and set your group order. Ramesh Mode groups positive finalized quantities, lists paused regulars under Do not stop, and prepares a WhatsApp helper message. Changed packing facts or pending requests block sharing until reviewed and finalized. It is a handover list, not GPS route optimization or proof of delivery.",
  },
  {
    question: "Can I use my WhatsApp messages?",
    answer:
      "Yes. Connect your kitchen phone by scanning the QR code and link your customer contacts. Incoming text orders are captured automatically and analysed into drafts when AI is configured. You can still paste a message manually. Approval always stays with you.",
  },
  {
    question: "Can AI approve a change for me?",
    answer:
      "No. AI-assisted changes are drafts for your review. Check them and approve the correct changes yourself. Finalising the packing sheet requires reviewed changes.",
  },
  {
    question: "How do I set up my workspace?",
    answer:
      "Choose Set up workspace, sign in with Google, and follow the onboarding steps for your kitchen. Then add your customers and recurring meal schedules.",
  },
  {
    question: "Can I keep recurring meal schedules?",
    answer:
      "Yes. Use recurring schedules as your starting point, then review the day's exceptions before finalising your cooking and packing plan.",
  },
  {
    question: "What about customer personal data?",
    answer:
      "Customer records and imported messages belong to your seller-scoped workspace. Review what you import and include only the customer information you need for kitchen operations.",
  },
];

export function LandingStory() {
  return (
    <>
      <section
        id="benefits"
        aria-labelledby="benefits-heading"
        className="scroll-mt-24 px-5 py-20 sm:px-8 lg:py-28"
      >
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-y-12 md:grid-cols-12 md:gap-y-16">
          <div className="flex min-w-0 flex-col items-start gap-6 md:col-span-8 md:justify-center md:pr-12">
            <Badge variant="outline">Built around your morning</Badge>
            <h2
              id="benefits-heading"
              className="max-w-2xl font-heading text-4xl leading-[1.08] tracking-tight text-balance sm:text-5xl lg:text-6xl"
            >
              Keep the changes.<br />Lose the guesswork.
            </h2>
            <p className="max-w-lg text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
              Regular orders are only the starting point. Bring today&apos;s
              exceptions into a review you can finish before the cooking begins.
              Then keep the handover and the month-end bill just as clear.
            </p>
          </div>
          <figure className="flex w-full min-w-0 max-w-80 flex-col gap-2 md:col-span-4 md:justify-self-end">
            <div className="relative aspect-square overflow-hidden rounded-2xl border border-border">
              <Image
                src="/landing/meal.jpg"
                alt="A steel thali with roti, dal, and vegetables"
                fill
                loading="lazy"
                sizes="(min-width: 1024px) 320px, (min-width: 768px) 30vw, (min-width: 360px) 320px, calc(100vw - 40px)"
                className="object-cover"
              />
            </div>
            <figcaption className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
              Food photography from
              <a
                href="https://unsplash.com"
                className="inline-flex min-h-11 items-center rounded-sm underline underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                Unsplash
              </a>
            </figcaption>
          </figure>
          <Separator className="md:col-span-12" />
          {features.map(({ icon: Icon, title, description, layout }, index) => (
            <article key={title} className={cn("flex min-w-0 flex-col items-start gap-6 py-6", layout)}>
              <div className="flex w-full items-center justify-between gap-4 text-primary">
                <span className="font-mono text-xs tracking-widest" aria-hidden="true">
                  0{index + 1}
                </span>
                <Icon aria-hidden="true" strokeWidth={1.5} className="size-6" />
              </div>
              <div className="flex min-w-0 flex-col gap-4">
                <h3 className="max-w-xs font-heading text-2xl leading-tight tracking-tight text-balance lg:text-3xl">
                  {title}
                </h3>
                <p className="max-w-md text-base leading-relaxed text-pretty text-muted-foreground">
                  {description}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="billing-delivery" aria-labelledby="billing-delivery-heading" className="scroll-mt-24 bg-muted/30 px-5 py-20 sm:px-8 lg:py-24">
        <div className="mx-auto max-w-7xl">
          <p className="mb-5 font-mono text-xs tracking-widest text-primary">AFTER THE COOKING</p>
          <h2 id="billing-delivery-heading" className="max-w-3xl font-heading text-4xl leading-[1.08] tracking-tight text-balance sm:text-5xl">From the scooter stop<br />to the first of the month.</h2>
          <div className="mt-12 grid gap-12 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] md:gap-16">
            <article className="flex min-w-0 flex-col items-start gap-5 border-t border-dashed pt-7">
              <div className="flex w-full flex-wrap items-center justify-between gap-4"><Badge variant="outline">The monthly bill book</Badge><ReceiptText strokeWidth={1.5} className="size-6 shrink-0 text-primary" aria-hidden="true" /></div>
              <h3 className="max-w-md font-heading text-3xl tracking-tight text-balance sm:text-4xl">“Can you check<br />those three days?”<br /><span className="text-muted-foreground">Already accounted for.</span></h3>
              <p className="max-w-lg text-base leading-relaxed text-muted-foreground">Build a monthly statement from finalized meal records. Dated skips, extras and agreed adjustments explain the total—without scrolling through four weeks of chats.</p>
              <ul className="flex flex-col gap-3 text-sm"><li>Agreed prices. Credits applied once.</li><li>Dated packing-sheet and approval references.</li><li>Saved statement versions, optional UPI, and WhatsApp sharing.</li></ul>
              <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">Issue after the month closes and required records are complete. Half-portion charges need your explicit billing adjustment; a statement is not confirmation of payment or delivery.</p>
            </article>
            <article className="flex min-w-0 flex-col items-start gap-5 border-t border-dashed pt-7 md:mt-16">
              <div className="flex w-full flex-wrap items-center justify-between gap-4"><Badge variant="outline">Ramesh Mode</Badge><Route strokeWidth={1.5} className="size-6 shrink-0 text-primary" aria-hidden="true" /></div>
              <h3 className="max-w-md font-heading text-3xl tracking-tight text-balance sm:text-4xl">Right building.<br />Right lunches.<br /><span className="text-muted-foreground">No cancelled stops.</span></h3>
              <p className="max-w-lg text-base leading-relaxed text-muted-foreground">Group the finalized packing list by your buildings or routes. See each stop&apos;s quantity and delivery note, with paused regulars clearly separated under “Do not stop today.”</p>
              <ul className="flex flex-col gap-3 text-sm"><li>Your group order, not a guessed driving route.</li><li>Unassigned stops stay visible.</li><li>One helper message, ready to open in WhatsApp.</li></ul>
              <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">Sharing opens a composer. You choose or confirm the recipient, review the message, and send. Changed packing facts need a fresh finalized sheet.</p>
            </article>
          </div>
          <Link href="/signin" className={cn(buttonVariants({ size: "lg" }), "mt-10 min-h-12 w-full sm:w-auto")}>Set up your kitchen<ArrowRight strokeWidth={1.5} data-icon="inline-end" aria-hidden="true" /></Link>
        </div>
      </section>

      <section
        id="questions"
        aria-labelledby="questions-heading"
        className="scroll-mt-24 px-5 py-20 sm:px-8 lg:py-28"
      >
        <div className="mx-auto max-w-7xl">
          <div className="mb-12 flex max-w-xl flex-col gap-4">
            <p className="font-mono text-xs tracking-widest text-primary uppercase">Before the first meal</p>
            <h2 id="questions-heading" className="font-heading text-4xl leading-tight tracking-tight text-balance sm:text-5xl">
              A few practical answers.
            </h2>
            <p className="max-w-md text-base leading-relaxed text-pretty text-muted-foreground">
              The connections, the setup, and the decisions that stay with you.
            </p>
          </div>
          <div className="grid grid-cols-1 items-start gap-x-16 md:grid-cols-2 lg:gap-x-24">
            {[questions.slice(0, 4), questions.slice(4)].map((column, columnIndex) => (
              <div key={columnIndex} className="min-w-0">
                <Separator className={cn(columnIndex === 1 && "hidden md:block")} />
                {column.map(({ question, answer }) => (
                  <div key={question}>
                    <details className="group">
                      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 rounded-sm py-5 font-medium transition-colors outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
                        <span className="min-w-0 flex-1 wrap-anywhere">{question}</span>
                        <span aria-hidden="true" className="relative flex size-5 shrink-0 items-center justify-center text-primary">
                          <span className="absolute h-px w-3 bg-current" />
                          <span className="absolute h-3 w-px bg-current transition-transform duration-150 group-open:scale-y-0 motion-reduce:transition-none" />
                        </span>
                      </summary>
                      <p className="pb-6 pr-8 text-sm leading-relaxed wrap-anywhere text-pretty text-muted-foreground sm:text-base">
                        {answer}
                      </p>
                    </details>
                    <Separator />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="start-heading" className="bg-primary/5 px-5 py-20 sm:px-8 lg:py-28">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-8">
          <CookingPot aria-hidden="true" strokeWidth={1.5} className="size-12 text-primary sm:size-16" />
          <h2 id="start-heading" className="max-w-5xl font-heading text-5xl leading-[1.04] tracking-tight text-balance sm:text-6xl md:text-7xl lg:text-8xl">
            Good food.<br />A clearer day.
          </h2>
          <p className="max-w-lg text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
            Set up your kitchen, add your regulars, and give tomorrow&apos;s
            changes a place to land.
          </p>
          <Link
            href="/signin"
            className={cn(buttonVariants({ size: "lg" }), "min-h-12 w-full px-6 transition-colors focus-visible:ring-offset-4 focus-visible:ring-offset-background motion-reduce:transition-none sm:w-auto")}
          >
            Set up workspace
            <ArrowRight aria-hidden="true" strokeWidth={1.5} data-icon="inline-end" />
          </Link>
        </div>
      </section>

      <footer className="px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="flex items-center gap-2 font-heading text-lg tracking-tight">
              <CookingPot aria-hidden="true" strokeWidth={1.5} className="size-5 text-primary" />
              TiffinTally
            </p>
            <p className="text-xs text-muted-foreground">Morning changes. Reviewed plans. Ready to pack.</p>
          </div>
          <nav aria-label="Footer" className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
            <Link
              href="#benefits"
              className="inline-flex min-h-11 items-center rounded-sm text-sm text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 motion-reduce:transition-none"
            >
              Benefits
            </Link>
            <Link
              href="#questions"
              className="inline-flex min-h-11 items-center rounded-sm text-sm text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 motion-reduce:transition-none"
            >
              Questions
            </Link>
            <Link
              href="/dashboard"
              className={cn(buttonVariants({ variant: "link" }), "min-h-11 px-0 transition-colors focus-visible:ring-offset-4 motion-reduce:transition-none")}
            >
              Open workspace
              <ArrowRight aria-hidden="true" strokeWidth={1.5} data-icon="inline-end" />
            </Link>
          </nav>
        </div>
      </footer>
    </>
  );
}
