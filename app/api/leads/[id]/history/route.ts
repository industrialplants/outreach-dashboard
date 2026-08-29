import { NextResponse } from "next/server";
import { ADMIN_TOKEN } from "@/lib/db";
import { getLeadHistory } from "@/lib/store";

// GET /api/leads/[id]/history?token=<admin token>
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/leads/[id]/history">,
) {
  const { id } = await ctx.params;
  const leadId = Number(id);
  if (!Number.isInteger(leadId)) {
    return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const history = await getLeadHistory(leadId);
  return NextResponse.json({ ok: true, history });
}
