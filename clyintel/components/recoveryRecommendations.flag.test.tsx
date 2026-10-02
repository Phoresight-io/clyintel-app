// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Launch gate (Sep 14): Client Score ships without recovery recommendations.
// With RECOVERY_RECOMMENDATIONS_ENABLED = false, neither the dashboard nor client
// detail renders the Recovery Recommendations box or the Payment Terms widget,
// while the Recovery YTD tile and the Client Score block still render.
//
// The flag is mocked through a mutable getter so one test can flip it on and
// prove the flag (not an empty data source) is what hides the section.
const flags = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/features", () => ({
  get RECOVERY_RECOMMENDATIONS_ENABLED() {
    return flags.on;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("@/lib/supabase-browser", () => ({
  createSupabaseBrowser: () => ({}),
}));

import DashboardScreen from "@/components/dashboard/DashboardScreen";
import DetailScreen from "@/components/detail/DetailScreen";
import type { Client, ClientInvoiceSet } from "@/lib/mock-data";

const client: Client = {
  id: "e8fdf1f0-0b2a-4b04-b474-66a497fb60b7",
  name: "Acme Co",
  industry: "Construction",
  score: 72,
  prevScore: 68,
  provisional: false,
  status: "past_due",
  balance: 1200,
  daysOverdue: 12,
  invoices: 1,
  lastActivity: "—",
  nextAction: "—",
  scoreSummary: ["Pays within 30 days on average"],
  scoreFactors: ["$1,200.00 billed across 1 invoice"],
  riskDrivers: ["One invoice past due"],
};

const invoiceSet: ClientInvoiceSet = {
  outstanding: [{ id: "1038", amount: 1200, dueDate: "2026-09-14", status: "past_due", lastActivity: "—", daysOverdue: 12 }],
  upcoming: [],
  paid: [],
};

const renderDashboard = () =>
  render(
    <DashboardScreen
      initialClients={[client]}
      initialClientInvoices={{ [client.id]: invoiceSet }}
      recoveryYTD={{ ok: true, totalCents: 569135, byClientCents: { [client.id]: 390000 } }}
    />,
  );

const renderDetail = () => render(<DetailScreen client={client} invoiceSet={invoiceSet} contacts={[]} />);

afterEach(() => {
  cleanup();
  flags.on = false;
});

describe("recovery recommendations launch flag", () => {
  it("ships off", async () => {
    const actual = await vi.importActual<typeof import("@/lib/features")>("@/lib/features");
    expect(actual.RECOVERY_RECOMMENDATIONS_ENABLED).toBe(false);
  });

  it("dashboard: no Recovery Recommendations section; Recovery YTD tile and invoice row still render", () => {
    renderDashboard();
    expect(screen.queryByText("Recovery Recommendations")).not.toBeInTheDocument();
    expect(screen.queryByText("No recommendations at this time.")).not.toBeInTheDocument();
    expect(screen.queryByText("Payment Terms Recommendation")).not.toBeInTheDocument();
    expect(screen.getByText("Recovery YTD")).toBeInTheDocument();
    expect(screen.getByText("$5,691.35")).toBeInTheDocument();
    expect(screen.getByText("1038")).toBeInTheDocument();
  });

  it("client detail: no Recovery Recommendations or Payment Terms widget; score block still renders", () => {
    renderDetail();
    expect(screen.queryByText("Recovery Recommendations")).not.toBeInTheDocument();
    expect(screen.queryByText("No recommendations at this time.")).not.toBeInTheDocument();
    expect(screen.queryByText("Payment Terms Recommendation")).not.toBeInTheDocument();
    expect(screen.getByText("Client Score")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("Score Summary")).toBeInTheDocument();
    expect(screen.getByText("• Pays within 30 days on average")).toBeInTheDocument();
  });

  it("the flag is what hides it: flipped on, the section renders on both screens", () => {
    flags.on = true;
    renderDashboard();
    expect(screen.getByText("Recovery Recommendations")).toBeInTheDocument();
    cleanup();
    renderDetail();
    expect(screen.getByText("Recovery Recommendations")).toBeInTheDocument();
  });
});
