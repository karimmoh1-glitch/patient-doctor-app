import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { patientProfile: true, doctorProfile: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let pairings;
  if (user.role === "PATIENT" && user.patientProfile) {
    pairings = await prisma.pairing.findMany({
      where: { patientId: user.patientProfile.id },
      include: {
        doctor: { include: { user: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      pairings: pairings.map((p) => ({
        id: p.id,
        status: p.status,
        createdAt: p.createdAt,
        counterpart: {
          name: p.doctor.user.name,
          specialty: p.doctor.specialty,
          phone: p.doctor.phone,
        },
      })),
    });
  } else if (user.role === "DOCTOR" && user.doctorProfile) {
    pairings = await prisma.pairing.findMany({
      where: { doctorId: user.doctorProfile.id },
      include: {
        patient: { include: { user: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      pairings: pairings.map((p) => ({
        id: p.id,
        status: p.status,
        createdAt: p.createdAt,
        counterpart: {
          name: p.patient.user.name,
          symptoms: p.patient.symptoms,
        },
      })),
    });
  }

  return NextResponse.json({ pairings: [] });
}

const createSchema = z.object({ doctorId: z.string() });

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "PATIENT") {
    return NextResponse.json({ error: "Only patients can request a pairing" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const patientProfile = await prisma.patientProfile.findUnique({
    where: { userId: session.userId },
  });
  if (!patientProfile) {
    return NextResponse.json({ error: "Patient profile not found" }, { status: 404 });
  }

  const doctor = await prisma.doctorProfile.findUnique({ where: { id: parsed.data.doctorId } });
  if (!doctor) {
    return NextResponse.json({ error: "Doctor not found" }, { status: 404 });
  }

  const existing = await prisma.pairing.findUnique({
    where: { patientId_doctorId: { patientId: patientProfile.id, doctorId: doctor.id } },
  });
  if (existing) {
    return NextResponse.json({ pairing: existing });
  }

  const pairing = await prisma.pairing.create({
    data: {
      patientId: patientProfile.id,
      doctorId: doctor.id,
      status: "PENDING",
    },
  });

  return NextResponse.json({ pairing });
}
