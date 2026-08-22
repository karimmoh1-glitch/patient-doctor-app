import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { customAlphabet } from "@/lib/id";
import { rateLimit } from "@/lib/rateLimit";

const patientSchema = z.object({
  role: z.literal("PATIENT"),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  symptoms: z.string().max(4000).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  locationLabel: z.string().max(200).optional(),
  inviteCode: z.string().max(20).optional(),
});

const doctorSchema = z.object({
  role: z.literal("DOCTOR"),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  specialty: z.string().min(1).max(100),
  phone: z.string().trim().min(3).max(30),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  locationLabel: z.string().max(200).optional(),
});

const MAX_INVITE_CODE_ATTEMPTS = 5;

export async function POST(req: NextRequest) {
  const { allowed, retryAfterSeconds } = rateLimit(req, "signup", { limit: 10, windowMs: 60 * 60_000 });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many signups from this network. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }

  const body = await req.json();
  const parsedRole = z.object({ role: z.enum(["PATIENT", "DOCTOR"]) }).safeParse(body);
  if (!parsedRole.success) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
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

    let user;
    try {
      user = await prisma.user.create({
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
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return NextResponse.json({ error: "Email already registered" }, { status: 409 });
      }
      throw e;
    }

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

    let user;
    for (let attempt = 0; ; attempt++) {
      const inviteCode = customAlphabet(6);
      try {
        user = await prisma.user.create({
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
        break;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          const target = e.meta?.target;
          const targetsEmail = Array.isArray(target) ? target.includes("email") : String(target).includes("email");
          if (targetsEmail) {
            return NextResponse.json({ error: "Email already registered" }, { status: 409 });
          }
          // otherwise it was an inviteCode collision — retry with a new code
          if (attempt < MAX_INVITE_CODE_ATTEMPTS - 1) continue;
          return NextResponse.json({ error: "Could not generate a unique invite code, please try again" }, { status: 500 });
        }
        throw e;
      }
    }

    await createSession({ userId: user.id, role: "DOCTOR" });
    return NextResponse.json({ ok: true });
  }
}
