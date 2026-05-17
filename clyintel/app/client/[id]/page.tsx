import { Suspense } from "react";
import { notFound } from "next/navigation";
import { clients } from "@/lib/mock-data";
import DetailScreen from "@/components/detail/DetailScreen";

export default function ClientDetailPage({ params }: { params: { id: string } }) {
  const client = clients.find(c => c.id.toString() === params.id);
  if (!client) notFound();
  return (
    <Suspense fallback={null}>
      <DetailScreen client={client} />
    </Suspense>
  );
}
