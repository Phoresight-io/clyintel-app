# Delta Spec — Clyintel Demo Build
_Product: clyintel | Status: Approved | Created: 2026-05-17_

---

## Objective

Port the Clyintel prototype (`clyintel_after.jsx`) into a deployable Next.js App Router
application with mock data. No auth. No Airtable. No Supabase. Demo-ready on Vercel.

---

## Screens In Scope

| Screen | Route | Source Component |
|---|---|---|
| Recovery Dashboard | `/` | `DashboardScreen` + `NegotiationActions` + `RecoveryRecModal` + `ExchangeDrawer` |
| Portfolio | `/portfolio` | `ClientListScreen` |
| Client Detail | `/client/[id]` | `DetailScreen` + `ExchangeDrawer` |

**Out of scope:** `ConnectionsScreen`, auth, real data, Supabase, Airtable.

---

## Target File Structure

```
app/
  layout.tsx                  ← Shell: nav, footer, font loading
  page.tsx                    ← Recovery Dashboard
  portfolio/
    page.tsx                  ← Portfolio Dashboard
  client/
    [id]/
      page.tsx                ← Client Detail

components/
  shell/
    AppShell.tsx              ← Nav + footer wrapper (client component)
  dashboard/
    DashboardScreen.tsx
    NegotiationActions.tsx
    RecoveryRecModal.tsx
  portfolio/
    ClientListScreen.tsx
  detail/
    DetailScreen.tsx
  shared/
    ExchangeDrawer.tsx

lib/
  theme.ts                    ← C color/font token object
  mock-data.ts                ← All mock arrays (clients, clientInvoices,
                                 invoiceExchanges, negotiationRecs, etc.)
```

---

## Transformation Rules

1. **`"use client"` on every component file** — all components use React state.
2. **No IIFE inside JSX** — move any inline (() => {})() calculations to component
   top level before the return statement.
3. **Keep all inline styles exactly as-is** — do not convert to Tailwind or CSS modules.
4. **Extract the `C` token object verbatim** into `lib/theme.ts` as a named export.
   Import it in every component file that uses it.
5. **Extract all mock data arrays verbatim** into `lib/mock-data.ts` as named exports:
   `clients`, `clientInvoices`, `invoiceExchanges`, `negotiationRecs`,
   `invoiceServices`, `importedClients`, `MANUAL_FIELDS`.
6. **Navigation routing:** Replace `setScreen("dashboard")` → `router.push("/")`
   and `setScreen("client-list")` → `router.push("/portfolio")`.
   Client detail: `router.push(\`/client/${client.id}\`)`.
   Use `useRouter` from `next/navigation`.
7. **Client Detail route:** `/client/[id]/page.tsx` receives `params.id`, looks up
   the client from the `clients` mock array by `id.toString()`.
8. **Font loading:** Load Inter and JetBrains Mono via `next/font/google` in
   `app/layout.tsx`. Apply as CSS variables `--font-sans` and `--font-mono`.
   Update `C.sans` and `C.mono` in `lib/theme.ts` to reference these CSS variables.
9. **Active nav state:** Derive from `usePathname()` — no screen state needed in shell.
10. **`previousScreen` back-nav logic:** In `DetailScreen`, derive back destination
    from the HTTP referrer or pass as a query param `?from=portfolio`. Default to `/`.

---

## Acceptance Criteria

- [ ] `npm run dev` starts without errors
- [ ] Recovery Dashboard loads at `/` with KPI cards, rec panel, invoice table
- [ ] Clicking an invoice number opens the Exchange Drawer
- [ ] Clicking "Review" on a rec card opens the RecoveryRecModal
- [ ] Clicking a client name navigates to `/client/[id]`
- [ ] Portfolio loads at `/portfolio` with summary cards and client table
- [ ] Client Detail loads at `/client/[id]` with PTR widget and invoice history
- [ ] Nav active state reflects current route
- [ ] "Back" links navigate correctly
- [ ] `npm run build` passes with no TypeScript errors
- [ ] Deployed to Vercel and accessible via public URL

---

## Out of Scope (explicitly)

- Auth of any kind
- Supabase or Airtable data connections
- ConnectionsScreen / Add Client flow
- Mobile responsiveness (desktop-only for demo)
- Settings tab (keep greyed out as-is)
