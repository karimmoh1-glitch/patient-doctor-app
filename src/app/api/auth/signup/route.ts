import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { customAlphabet } from "@/lib/id";

const patientSchema = z.object({
  role: z.literal("PATIENT"),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  symptoms: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  locationLabel: z.string().optional(),
  inviteCode: z.string().optional(),
});

const doctorSchema = z.object({
  role: z.literal("DOCTOR"),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  specialty: z.string().min(1),
  phone: z.string().min(3),
  lat: z.number().optional(),
  lng: z.number().optional(),
  locationLabel: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsedRole = z.object({ role: z.enum(["PATIENT", "DOCTOR"]) }).safeParse(body);
  if (!parsedRole.success) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  if (parsedRole.data.role === "PATIENT") {
    const parsed = patientSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    const data = parsed.data;
    const passwordHash = await bcrypt.hash(data.password, 10);

    let doctorProfileToJoin = null;
    if (data.inviteCode) {
      doctorProfileToJoin = await prisma.doctorProfile.findUnique({
        where: { inviteCode: data.inviteCode.trim().toUpperCase() },
      });
      if (!doctorProfileToJoin) {
        return NextResponse.json({ error: "Invite code not found" }, { status: 404 });
      }
    }

    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash,
        role: "PATIENT",
        patientProfile: {
          create: {
            symptoms: data.symptoms,
            lat: data.lat,
            lng: data.lng,
            locationLabel: data.locationLabel,
          },
        },
      },
      include: { patientProfile: true },
    });

    if (doctorProfileToJoin && user.patientProfile) {
      await prisma.pairing.create({
        data: {
          patientId: user.patientProfile.id,
          doctorId: doctorProfileToJoin.id,
          status: "ACCEPTED",
        },
      });
    }

    await createSession({ userId: user.id, role: "PATIENT" });
    return NextResponse.json({ ok: true });
  } else {
    const parsed = doctorSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    const data = parsed.data;
    const passwordHash = await bcrypt.hash(data.password, 10);
    const inviteCode = customAlphabet(6);

    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash,
        role: "DOCTOR",
        doctorProfile: {
          create: {
            specialty: data.specialty,
            phone: data.phone,
            lat: data.lat,
            lng: data.lng,
            locationLabel: data.locationLabel,
            inviteCode,
          },
        },
      },
    });

    await createSession({ userId: user.id, role: "DOCTOR" });
    return NextResponse.json({ ok: true });
  }
}
