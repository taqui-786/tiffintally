"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("dashboard_route_error", error.digest ?? "unknown"); }, [error]);
  return <main className="flex min-h-dvh min-w-0 items-center justify-center bg-muted/30 px-4 py-10"><Alert variant="destructive" className="w-full min-w-0 max-w-lg"><AlertTitle>Workspace unavailable</AlertTitle><AlertDescription className="flex min-w-0 flex-col gap-4 wrap-anywhere"><span>Something interrupted the workspace. Your saved backend data was not changed by this screen.</span><Button variant="outline" onClick={reset}>Try again</Button></AlertDescription></Alert></main>;
}
