import ConnectionsScreen from "@/components/connections/ConnectionsScreen";

// /connections is acquisition-only: connect a new invoice source, import a file,
// or enter an invoice manually. QBO connection MANAGEMENT (status, realm, expiry,
// reauthorize, disconnect) lives solely on /settings Integrations — a connected
// QuickBooks tile here routes there via "Manage →".
export default function ConnectionsPage() {
  return <ConnectionsScreen />;
}
