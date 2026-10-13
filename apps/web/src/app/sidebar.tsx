"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { href: "/", label: "Overview", code: "01" },
  { href: "/approvals", label: "Approvals", code: "02" },
  { href: "/ledger", label: "Audit ledger", code: "03" },
  { href: "/chat", label: "Agent workspace", code: "04" },
  { href: "/onboarding", label: "Business setup", code: "05" },
];

export default function Sidebar() {
  const pathname = usePathname();

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
