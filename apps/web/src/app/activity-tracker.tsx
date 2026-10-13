"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export default function ActivityTracker() {
  const pathname = usePathname();

  useEffect(() => {
    const activityToken = window.localStorage.getItem("agentvault.activityToken");
    if (!activityToken) return;
    const event =
      pathname === "/"
        ? "dashboard_view"
        : pathname === "/chat"
          ? "chat_opened"
          : pathname === "/ledger"
            ? "ledger_viewed"
            : pathname === "/approvals"
              ? "approval_reviewed"
              : null;
    if (!event) return;

    void fetch(`${API_BASE}/api/onboarding/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${activityToken}`,
      },
      body: JSON.stringify({ event }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          console.error("Unable to record workspace activity:", body.error || response.statusText);
        }
      })
      .catch((cause: unknown) => {
        console.error("Unable to reach the workspace activity endpoint:", cause);
      });
  }, [pathname]);

  return null;
}
