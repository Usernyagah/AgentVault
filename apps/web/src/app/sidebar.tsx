"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const navigation = [
  { href: "/", label: "Overview", code: "01" },
  { href: "/approvals", label: "Approvals", code: "02" },
  { href: "/ledger", label: "Audit ledger", code: "03" },
  { href: "/chat", label: "Agent workspace", code: "04" },
  { href: "/onboarding", label: "Business setup", code: "05" },
];

type ApplicationMode = "demo" | "live" | "unknown";
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export default function Sidebar() {
  const pathname = usePathname();
  const [mode, setMode] = useState<ApplicationMode>("unknown");

  useEffect(() => {
    let active = true;
    const refreshMode = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/demo`, { cache: "no-store" });
        const result = await response.json();
        const apiMode = result.data?.mode;
        if (
          !response.ok ||
          !result.success ||
          (apiMode !== "demo" && apiMode !== "live") ||
          response.headers.get("X-AgentVault-Mode") !== apiMode
        ) {
          throw new Error(result.error || "API mode status is unavailable.");
        }
        if (active) setMode(apiMode);
      } catch (error) {
        console.error("Unable to verify application mode:", error);
        if (active) setMode("unknown");
      }
    };

    void refreshMode();
    const timer = window.setInterval(() => void refreshMode(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <aside className="sidebar">
      <Link className="sidebar-brand" href="/" aria-label="AgentVault overview">
        <span className="brand-mark" aria-hidden="true">A</span>
        <span className="brand-wordmark">AgentVault</span>
      </Link>

      <div className="sidebar-section-label">TREASURY</div>
      <nav aria-label="Main navigation">
        <ul className="sidebar-nav">
          {navigation.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`sidebar-link${active ? " active" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="sidebar-link-code" aria-hidden="true">{item.code}</span>
                  {item.label}
                  {item.href === "/approvals" && (
                    <span className="sidebar-link-arrow" aria-hidden="true">↗</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className={`sidebar-mode sidebar-mode-${mode}`} role="status" aria-live="polite">
        <strong>
          {mode === "demo"
            ? "DEMO MODE"
            : mode === "live"
              ? "LIVE MODE"
              : "MODE UNKNOWN"}
        </strong>
        <span>
          {mode === "demo"
            ? "Synthetic data only"
            : mode === "live"
              ? "Real Arc testnet data"
              : "API mode not verified"}
        </span>
      </div>

      <div className="sidebar-footer">
        <span className="network-indicator" />
        <div>
          <strong>Arc testnet</strong>
          <span>Chain 5042002</span>
        </div>
      </div>
    </aside>
  );
}
