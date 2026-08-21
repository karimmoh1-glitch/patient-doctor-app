import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

async function authorizePairing(pairingId: string, userId: string) {
  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: {
      patient: { include: { user: true } },
      doctor: { include: { user: true } },
    },
  });
  if (!pairing) return null;
  if (pairing.patient.user.id !== userId && pairing.doctor.user.id !== userId) return null;
  return pairing;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pairing = await authorizePairing(id, session.userId);
  if (!pairing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const messages = await prisma.message.findMany({
    where: { pairingId: id },
    orderBy: { createdAt: "asc" },
    include: { sender: { select: { name: true, id: true } } },
  });

  return NextResponse.json({
    messages: messages.map((m) => ({
      id: m.id,
      text: m.text,
      createdAt: m.createdAt,
      senderId: m.senderId,
      senderName: m.sender.name,
      mine: m.senderId === session.userId,
    })),
    counterpart: {
      name: pairing.patient.user.id === session.userId ? pairing.doctor.user.name : pairing.patient.user.name,
      phone: pairing.doctor.phone,
    },
    status: pairing.status,
  });
}

const schema = z.object({ text: z.string().min(1).max(2000) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pairing = await authorizePairing(id, session.userId);
  if (!pairing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (pairing.status !== "ACCEPTED") {
    return NextResponse.json({ error: "Pairing not accepted yet" }, { status: 400 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const message = await prisma.message.create({
    data: {
      pairingId: id,
      senderId: session.userId,
      text: parsed.data.text,
    },
  });

  return NextResponse.json({ message });
}
