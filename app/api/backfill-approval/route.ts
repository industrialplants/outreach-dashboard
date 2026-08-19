import { NextResponse } from "next/server";
import { ADMIN_TOKEN } from "@/lib/db";
import { backfillApprovalForAlreadySent } from "@/lib/store";

interface Body {
  adminToken?: string;
  clientToken?: string;
}

// POST /api/backfill-approval { adminToken, clientToken }
// Safe one-time cleanup: only backfills approval timestamps for channels
// that have already been sent (no send-eligibility risk either way).
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
  if (!body.clientToken) {
    return NextResponse.json({ error: "clientToken fehlt" }, { status: 400 });
  }

  const updated = await backfillApprovalForAlreadySent(body.clientToken);
  return NextResponse.json({ ok: true, updated });
}
