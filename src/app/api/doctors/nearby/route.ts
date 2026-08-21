import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { distanceMiles } from "@/lib/geo";
import { suggestSpecialty } from "@/lib/specialty";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lng = parseFloat(searchParams.get("lng") ?? "");
  const symptoms = searchParams.get("symptoms") ?? "";

  const doctors = await prisma.doctorProfile.findMany({
    include: { user: { select: { name: true } } },
  });

  const suggested = symptoms ? suggestSpecialty(symptoms) : null;

  const withDistance = doctors.map((d) => ({
    id: d.id,
    name: d.user.name,
    specialty: d.specialty,
    locationLabel: d.locationLabel,
    distanceMiles:
      !isNaN(lat) && !isNaN(lng) && d.lat != null && d.lng != null
        ? Math.round(distanceMiles(lat, lng, d.lat, d.lng) * 10) / 10
        : null,
    matchesSpecialty: suggested ? d.specialty === suggested : false,
  }));

  withDistance.sort((a, b) => {
    if (a.matchesSpecialty !== b.matchesSpecialty) return a.matchesSpecialty ? -1 : 1;
    if (a.distanceMiles == null) return 1;
    if (b.distanceMiles == null) return -1;
    return a.distanceMiles - b.distanceMiles;
  });

  return NextResponse.json({ doctors: withDistance, suggestedSpecialty: suggested });
}
