import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

export function LandingHero() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="px-5 pb-12 pt-10 sm:px-8 sm:pt-14 lg:pb-14"
    >
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-8 xl:gap-12">
        <div className="flex min-w-0 flex-col items-start gap-6 lg:gap-7">
          <Badge variant="outline" className="h-7 px-3">
            For independent tiffin kitchens
          </Badge>
          <h1
            id="hero-heading"
            className="max-w-full font-heading text-[clamp(2rem,10.8vw,3rem)] font-bold leading-[1.06] tracking-[-0.06em] text-balance text-foreground sm:text-[64px] lg:text-[56px] xl:text-[76px]"
          >
            <span className="block">More cooking.</span>
            <span className="block text-primary">
              Less chasing.
            </span>
          </h1>
          <p className="max-w-sm text-lg leading-relaxed text-pretty text-muted-foreground">
            Bring WhatsApp orders into reviewed meal plans, so your kitchen can
            focus on the food.
          </p>
          <div className="flex w-full min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Link
              href="/signin"
              className={buttonVariants({
                size: "lg",
                className:
                  "min-h-12 px-5 motion-reduce:transform-none motion-reduce:transition-none",
              })}
            >
              Set up workspace
            </Link>
            <a
              href="#workflow"
              className={buttonVariants({
                variant: "outline",
                size: "lg",
                className:
                  "min-h-12 px-5 motion-reduce:transform-none motion-reduce:transition-none",
              })}
            >
              See how it works
            </a>
          </div>
        </div>

        <figure className="relative w-full min-w-0 max-w-[600px] justify-self-end pl-4 pt-4 sm:pl-6 sm:pt-6 lg:pb-5">
          {/* An offset lid outline echoes the lunchboxes without framing a UI. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 aspect-[500/423] rounded-[3.5rem_1rem_4.5rem_1rem] border border-primary/25 bg-muted/40 sm:rounded-[4.5rem_1.25rem_5.5rem_1.25rem]"
          />
          <div className="relative aspect-[500/423] overflow-hidden rounded-[3.5rem_1rem_4.5rem_1rem] bg-muted sm:rounded-[4.5rem_1.25rem_5.5rem_1.25rem]">
            <Image
              src="/landing/tiffin-lunchboxes.jpg"
              alt="Colourful tiffin lunchboxes filled with Indian breads, rice, vegetables, fruit, and snacks"
              fill
              preload
              sizes="(min-width: 1125px) 576px, (min-width: 1024px) calc(58.333vw - 80px), (min-width: 664px) 576px, (min-width: 640px) calc(100vw - 88px), calc(100vw - 56px)"
              className="object-cover"
            />
          </div>
          <figcaption className="relative mt-5 max-w-full border-l-2 border-primary px-4 py-1 font-heading text-lg font-medium leading-snug tracking-tight wrap-anywhere text-foreground lg:absolute lg:bottom-9 lg:right-5 lg:mt-0 lg:max-w-[calc(100%-2.5rem)] lg:bg-background lg:px-5 lg:py-4 lg:shadow-sm">
            <span className="block">Made with care.</span>
            <span className="block">Packed with clarity.</span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
