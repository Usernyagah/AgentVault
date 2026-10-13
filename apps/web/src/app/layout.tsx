import type { Metadata } from "next";
import "./globals.css";
import ActivityTracker from "./activity-tracker";
import Sidebar from "./sidebar";

export const metadata: Metadata = {
  title: "AgentVault | Treasury Management",
  description:
    "Treasury operations, decision review, and signed audit records for Arc testnet.",
  keywords: ["treasury", "AI agent", "USDC", "Circle", "Arc", "DeFi", "autonomous"],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="app-layout">
          <Sidebar />
          <main className="main-content">{children}</main>
          <ActivityTracker />
        </div>
      </body>
    </html>
  );
}
