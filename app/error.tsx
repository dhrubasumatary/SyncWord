"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function ErrorScreen({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("SyncWord UI recovered from an error:", error);
  }, [error]);

  return (
    <main className="fatal-shell">
      <div className="fatal-card">
        <span>SYNCWORD RECOVERY</span>
        <h1>The render is still safe.</h1>
        <p>
          The editor hit a temporary display error. Retry the screen first—your
          server-side caption job may still be processing.
        </p>
        <button onClick={reset}>Restore editor</button>
        <Link href="/">Start over</Link>
      </div>
    </main>
  );
}
