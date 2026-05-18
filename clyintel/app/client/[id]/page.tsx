import { Suspense } from "react";
import { notFound } from "next/navigation";
import { clients } from "@/lib/mock-data";
import DetailScreen from "@/components/detail/DetailScreen";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = clients.find(c => c.id.toString() === id);
  if (!client) notFound();
  return (
    <Suspense fallback={null}>
      <DetailScreen client={client} />
    </Suspense>
  );
}
