import { NextResponse } from "next/server";
import { getClient } from "@/lib/store";
import { isValidStatus, updateLead } from "@/lib/store";
import { getDb, ADMIN_TOKEN } from "@/lib/db";
import type { Lead } from "@/lib/types";

interface PatchBody {
  status?: string;
  comment?: string;
  token?: string; // caller's board token, used to authorize the change
}

// Update a lead's status and/or comment (approve / reject / status dropdown).
export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/leads/[id]">,
) {
  const { id } = await ctx.params;
  const leadId = Number(id);
  if (!Number.isInteger(leadId)) {
    return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const lead = getDb()
    .prepare("SELECT * FROM leads WHERE id = ?")
    .get(leadId) as Lead | undefined;
  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  // Authorize: admin may edit any board; a client may only edit its own leads.
  const token = body.token?.trim();
  const isAdmin = token === ADMIN_TOKEN;
  if (!isAdmin) {
    if (!token || !getClient(token) || token !== lead.client_token) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (body.status !== undefined && !isValidStatus(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const updated = updateLead(leadId, {
    status: isValidStatus(body.status) ? body.status : undefined,
    comment: body.comment,
  });

  return NextResponse.json({ ok: true, lead: updated });
}
