"use client";

import { useId, useState } from "react";
import { ArrowRight, Check, MessageSquare, RotateCcw } from "lucide-react";
import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const examples = [
  {
    id: "skip",
    label: "Skip",
    customer: "Asha",
    message: "Please skip my lunch today.",
    before: 2,
    after: 0,
  },
  {
    id: "extra",
    label: "Extra",
    customer: "Kabir",
    message: "Please send three lunches today.",
    before: 1,
    after: 3,
  },
  {
    id: "change",
    label: "Change",
    customer: "Noor",
    message: "Just one lunch for me today, please.",
    before: 2,
    after: 1,
  },
] as const;

type Stage = "draft" | "review" | "approved";

const controlMotion =
  "transition-[opacity,transform]! duration-150 motion-safe:active:scale-[0.96] motion-reduce:transition-none! motion-reduce:transform-none motion-reduce:translate-none!";

export function ReviewDemo() {
  const headingId = useId();
  const statusId = useId();
  const [selected, setSelected] = useState<string>(examples[0].id);
  const [stage, setStage] = useState<Stage>("draft");
  const example = examples.find((item) => item.id === selected) ?? examples[0];
  const approved = stage === "approved";
  const total = 42 + (approved ? example.after - example.before : 0);
  const status = approved
    ? `${example.customer}'s example approved. Sample total changed from 42 to ${total} lunches.`
    : stage === "review"
      ? `Confirm ${example.customer}'s change from ${example.before} to ${example.after} lunches. Sample total stays at 42 until you approve.`
      : "Review the proposed change first. The sample total is unchanged.";

  function advanceExample() {
    setStage((current) =>
      current === "draft" ? "review" : current === "review" ? "approved" : "draft",
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="w-full min-w-0 max-w-[550px] overflow-hidden rounded-3xl border border-border bg-card text-card-foreground"
    >
      <div className="flex min-w-0 flex-col gap-5 p-5 sm:p-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-medium leading-relaxed text-muted-foreground">
            Interactive example · not your orders
          </p>
          <h3 id={headingId} className="text-xl font-semibold tracking-tight text-balance">
            A message. A reviewed change.
          </h3>
        </header>

        <Tabs
          value={selected}
          onValueChange={(value) => {
            if (typeof value === "string" && value !== selected) {
              setSelected(value);
              setStage("draft");
            }
          }}
          className="min-w-0 gap-5"
        >
          <TabsList
            aria-label="Fictional lunch-change examples"
            className="grid w-full grid-cols-3 group-data-horizontal/tabs:h-auto"
          >
            {examples.map((item) => (
              <TabsTrigger
                key={item.id}
                value={item.id}
                className={cn("h-auto min-h-11 min-w-0 cursor-pointer px-2 py-2 whitespace-normal wrap-anywhere", controlMotion, "motion-reduce:after:transition-none")}
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {examples.map((item) => (
            <TabsContent
              key={item.id}
              value={item.id}
              className="min-w-0 focus-visible:rounded-xl focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex min-w-0 flex-col gap-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {item.customer}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      Fictional customer
                    </span>
                  </p>
                  <Badge
                    variant={approved ? "default" : "secondary"}
                    className="h-6 transition-none!"
                  >
                    {approved && <Check aria-hidden="true" strokeWidth={1.5} data-icon="inline-start" />}
                    {approved ? "Approved" : stage === "review" ? "Ready to approve" : "Draft"}
                  </Badge>
                </div>

                <figure className="flex flex-col gap-2 rounded-xl bg-muted p-4">
                  <figcaption className="flex items-center gap-2 text-xs text-muted-foreground">
                    <MessageSquare aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
                    Original sample message
                  </figcaption>
                  <blockquote className="text-base leading-relaxed text-pretty">
                    “{item.message}”
                  </blockquote>
                </figure>

                <dl className="grid grid-cols-2 gap-6">
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">Before</dt>
                    <dd className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-3xl font-semibold tracking-tight tabular-nums">{item.before}</span>
                      <span className="text-xs text-muted-foreground">{item.before === 1 ? "lunch" : "lunches"}</span>
                    </dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">{approved ? "After approval" : "Proposed"}</dt>
                    <dd className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-3xl font-semibold tracking-tight tabular-nums">{item.after}</span>
                      <span className="text-xs text-muted-foreground">{item.after === 1 ? "lunch" : "lunches"}</span>
                    </dd>
                  </div>
                </dl>

                <Button
                  type="button"
                  variant={approved ? "outline" : "default"}
                  aria-describedby={statusId}
                  onClick={advanceExample}
                  className={cn("h-auto min-h-11 w-full cursor-pointer", controlMotion)}
                >
                  {approved ? (
                    <RotateCcw aria-hidden="true" strokeWidth={1.5} data-icon="inline-start" />
                  ) : stage === "review" ? (
                    <Check aria-hidden="true" strokeWidth={1.5} data-icon="inline-start" />
                  ) : null}
                  {approved ? "Reset example" : stage === "review" ? "Approve example" : "Review change"}
                  {stage === "draft" && <ArrowRight aria-hidden="true" strokeWidth={1.5} data-icon="inline-end" />}
                </Button>
              </div>
            </TabsContent>
          ))}
        </Tabs>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-muted px-4 py-3">
            <p className="text-sm font-medium">Sample lunch total</p>
            <p className="flex items-center gap-2 text-2xl font-semibold tracking-tight tabular-nums">
              {approved && <span className="text-base font-normal text-muted-foreground line-through"><span className="sr-only">Previously </span>42</span>}
              <span>{total}</span>
            </p>
          </div>
          <p id={statusId} role="status" aria-live="polite" aria-atomic="true" className="min-h-10 text-xs leading-relaxed text-muted-foreground text-pretty">
            {status}
          </p>
        </div>

        <footer className="flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground text-pretty">
          <p>In your workspace, drafts need your review before quantities change.</p>
          <p>Every example starts at 42 lunches. Switching examples resets the demo.</p>
        </footer>
      </div>
    </section>
  );
}

export default ReviewDemo;
