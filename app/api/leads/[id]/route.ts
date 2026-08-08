import { NextResponse } from "next/server";
import {
  deleteLead,
  getClient,
  getLead,
  isValidStatus,
  updateLead,
} from "@/lib/store";
import { ADMIN_TOKEN } from "@/lib/db";

interface PatchBody {
  status?: string;
  comment?: string;
  generated_message?: string;
  dm_sent_at?: string;
  email_sent_at?: string;
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

  const lead = await getLead(leadId);
  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  // Authorize: admin may edit any board; a client may only edit its own leads.
  const token = body.token?.trim();
  const isAdmin = token === ADMIN_TOKEN;
  if (!isAdmin) {
    if (!token || token !== lead.client_token || !(await getClient(token))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (body.status !== undefined && !isValidStatus(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const updated = await updateLead(leadId, {
    status: body.generated_message ? "revised" : (isValidStatus(body.status) ? body.status : undefined),
    comment: body.comment,
    generated_message: body.generated_message,
    dm_sent_at: body.dm_sent_at,
    email_sent_at: body.email_sent_at,
  });

  return NextResponse.json({ ok: true, lead: updated });
}

// Permanently delete a lead. Admin only — clients can't delete leads.
export async function DELETE(
  request: Request,
  ctx: RouteContext<"/api/leads/[id]">,
) {
  const { id } = await ctx.params;
  const leadId = Number(id);
  if (!Number.isInteger(leadId)) {
    return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  }

  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.token?.trim() !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!(await deleteLead(leadId))) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
