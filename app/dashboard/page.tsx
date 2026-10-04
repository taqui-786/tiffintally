"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import DashboardApp from "@/components/dashboard-app";
import { useSellerAuth } from "@/components/auth-state";
import { DashboardSkeleton } from "@/components/dashboard-skeleton";
import { ClientError } from "@/lib/client/api";

export default function DashboardPage() {
  const auth = useSellerAuth();
  const router = useRouter();
  const status = auth.error instanceof ClientError ? auth.error.status : undefined;

  useEffect(() => {
    if (status === 401) {
      router.replace("/signin");
    } else if (status === 403) {
      router.replace("/onboarding");
    }
  }, [status, router]);

  if (auth.isPending) return <DashboardSkeleton />;
  if (status === 401 || status === 403) return <DashboardSkeleton />;

  return <DashboardApp />;
}
