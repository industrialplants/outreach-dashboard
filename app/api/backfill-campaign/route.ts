import { NextResponse } from "next/server";
import { ADMIN_TOKEN } from "@/lib/db";
import { backfillCampaignFromChannel } from "@/lib/store";

interface Body {
  adminToken?: string;
  clientToken?: string;
  bothLabel?: string;
  linkedinLabel?: string;
}

// POST /api/backfill-campaign { adminToken, clientToken, bothLabel, linkedinLabel }
// Safe one-time tagging: only fills in leads with no campaign set yet.
export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.adminToken !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!body.clientToken || !body.bothLabel?.trim() || !body.linkedinLabel?.trim()) {
    return NextResponse.json(
      { error: "clientToken, bothLabel und linkedinLabel sind erforderlich" },
      { status: 400 },
    );
  }

  const updated = await backfillCampaignFromChannel(
    body.clientToken,
    body.bothLabel.trim(),
    body.linkedinLabel.trim(),
  );
  return NextResponse.json({ ok: true, updated });
}
