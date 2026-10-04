"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { OnboardingCard, useSellerAuth } from "@/components/auth-state";
import { DashboardSkeleton } from "@/components/dashboard-skeleton";
import { ClientError } from "@/lib/client/api";

export default function OnboardingPage() {
  const auth = useSellerAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.data) {
      router.replace("/dashboard");
    } else if (auth.error instanceof ClientError && auth.error.status === 401) {
      router.replace("/signin");
    }
  }, [auth.data, auth.error, router]);

  if (auth.isPending) return <DashboardSkeleton />;
  if (auth.data) return null;

  return (
    <main className="flex min-h-dvh min-w-0 items-center justify-center bg-muted/30 px-4 py-10">
      <OnboardingCard onCreated={() => router.replace("/dashboard")} />
    </main>
  );
}
