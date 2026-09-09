import { NextResponse } from "next/server";
import { deleteLeadsByIds } from "@/lib/store";
import { ADMIN_TOKEN } from "@/lib/db";

// Admin-only bulk delete. Deliberately a separate route from the single-lead
// DELETE so its blast radius is obvious and it can be removed cleanly once the
// one-time cleanup is done. It never deletes "everything for a token" on its
// own — the client sends the explicit list of ids currently visible under the
// active filter, and the delete is scoped to that client_token in SQL, so a
// stray id from another board simply doesn't match.
export async function POST(request: Request) {
  let body: { token?: string; clientToken?: string; ids?: number[] };
  try {
    body = (await request.json()) as {
      token?: string;
      clientToken?: string;
      ids?: number[];
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.token?.trim() !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const clientToken = body.clientToken?.trim();
  if (!clientToken) {
    return NextResponse.json({ error: "Kein Kunde angegeben" }, { status: 400 });
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return NextResponse.json({ error: "Keine Leads angegeben" }, { status: 400 });
  }

  const deleted = await deleteLeadsByIds(clientToken, body.ids);
  return NextResponse.json({ ok: true, deleted });
}
