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
  email_subject?: string;
  email_body?: string;
  accept_fields?: string[];
  revert_fields?: string[];
  dm_sent_at?: string;
  email_sent_at?: string;
  channel?: string; // admin-only: reassigns which channel(s) a lead is meant for
  email?: string; // admin-only: corrects/adds the contact email address
  paused?: boolean; // admin OR client: emergency stop, blocks all sending
  approve_channel?: "linkedin" | "email"; // separate approval per channel
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

  // Editing any of the three message fields resurfaces the lead for review,
  // regardless of who edited it (unless a status was explicitly requested).
  const editedAMessageField =
    body.generated_message !== undefined ||
    body.email_subject !== undefined ||
    body.email_body !== undefined;

  const updated = await updateLead(leadId, {
    status: editedAMessageField
      ? "revised"
      : isValidStatus(body.status)
        ? body.status
        : undefined,
    comment: body.comment,
    generated_message: body.generated_message,
    email_subject: body.email_subject,
    email_body: body.email_body,
    dm_sent_at: body.dm_sent_at,
    email_sent_at: body.email_sent_at,
    isAdminEdit: isAdmin,
    // Accept/revert only ever make sense as an admin review action.
    acceptFields: isAdmin ? body.accept_fields : undefined,
    revertFields: isAdmin ? body.revert_fields : undefined,
    // Admin-only, and deliberately independent of every other field here —
    // reassigning the channel must never touch the message text or its
    // review status, only which channel(s) the lead is eligible for.
    channel: isAdmin ? body.channel : undefined,
    // Admin-only: correcting/adding the contact email address for leads that
    // were originally sourced without one (e.g. a LinkedIn-only campaign).
    email: isAdmin ? body.email : undefined,
    // Emergency stop: intentionally NOT admin-gated — the whole point is
    // that a client can halt a lead themself the instant they spot a
    // problem, without needing to wait for someone on the agency side.
    paused: body.paused,
    approveChannel:
      body.approve_channel === "linkedin" || body.approve_channel === "email"
        ? body.approve_channel
        : undefined,
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
