import ConnectionsScreen from "@/components/connections/ConnectionsScreen";
import QuickBooksCard from "@/components/connections/QuickBooksCard";

export default function ConnectionsPage() {
  return (
    <>
      <div style={{ padding: "36px 48px 0" }}>
        <QuickBooksCard />
      </div>
      <ConnectionsScreen />
    </>
  );
}
