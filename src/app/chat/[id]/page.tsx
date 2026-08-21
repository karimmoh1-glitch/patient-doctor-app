import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import NavBar from "@/components/NavBar";
import ChatWindow from "@/components/ChatWindow";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/login");

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) redirect("/login");

  return (
    <div className="flex flex-1 flex-col h-screen">
      <NavBar name={user.name} role={user.role} />
      <ChatWindow pairingId={id} viewerRole={user.role} />
    </div>
  );
}
