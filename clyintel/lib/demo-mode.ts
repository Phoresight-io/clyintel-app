export const DEMO_RESET_KEY = 'clyintel_demo_reset';
export const CLIENTS_KEY = 'clyintel_clients';
export const INTEGRATIONS_KEY = 'clyintel_integrations';

export function isDemoReset(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(DEMO_RESET_KEY) === 'true';
}

// Single source of truth for the default integration list shape.
// Used by IntegrationsScreen (initial state) and ConnectionsScreen (base list when none stored).
export const DEFAULT_INTEGRATIONS = [
  { id: "qb",     name: "QuickBooks",   color: "#2CA01C", initial: "QB", logo: "https://cdn.simpleicons.org/quickbooks/FFFFFF",  subtitle: "Sync invoices from QuickBooks Online", status: "connected",    lastSync: "Today at 2:14 PM", clients: 6,  invoices: 24 },
  { id: "fb",     name: "FreshBooks",   color: "#1068e0", initial: "FB", logo: "https://cdn.simpleicons.org/freshbooks/FFFFFF",  subtitle: "Sync invoices from FreshBooks",         status: "disconnected", lastSync: null,               clients: 0,  invoices: 0  },
  { id: "stripe", name: "Stripe",       color: "#635BFF", initial: "ST", logo: "https://cdn.simpleicons.org/stripe/FFFFFF",      subtitle: "Sync invoices from Stripe Billing",     status: "disconnected", lastSync: null,               clients: 0,  invoices: 0  },
  { id: "xero",   name: "Xero",         color: "#13B5EA", initial: "XR", logo: "https://cdn.simpleicons.org/xero/FFFFFF",        subtitle: "Sync invoices from Xero",               status: "disconnected", lastSync: null,               clients: 0,  invoices: 0  },
  { id: "gdrive", name: "Google Drive", color: "#1FA463", initial: "GD", logo: "https://cdn.simpleicons.org/googledrive/FFFFFF", subtitle: "Import from a spreadsheet in Drive",    status: "disconnected", lastSync: null,               clients: 0,  invoices: 0  },
];
