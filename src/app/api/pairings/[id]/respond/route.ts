import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

const schema = z.object({ action: z.enum(["ACCEPT", "DECLINE"]) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session || session.role !== "DOCTOR") {
    return NextResponse.json({ error: "Only doctors can respond" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const doctorProfile = await prisma.doctorProfile.findUnique({ where: { userId: session.userId } });
  if (!doctorProfile) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pairing = await prisma.pairing.findUnique({ where: { id } });
  if (!pairing || pairing.doctorId !== doctorProfile.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await prisma.pairing.update({
    where: { id },
    data: { status: parsed.data.action === "ACCEPT" ? "ACCEPTED" : "DECLINED" },
  });

  return NextResponse.json({ pairing: updated });
}
