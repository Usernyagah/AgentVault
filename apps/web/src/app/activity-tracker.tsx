"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { apiFetch } from "@/lib/api";

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

    void apiFetch<void>("/api/onboarding/activity", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${activityToken}`,
      },
      body: JSON.stringify({ event }),
    })
      .then(() => undefined)
      .catch((cause: unknown) => {
        console.error("Unable to reach the workspace activity endpoint:", cause);
      });
  }, [pathname]);

  return null;
}
