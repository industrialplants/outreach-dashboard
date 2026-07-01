import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  createClient,
  deleteClient,
  listClientsWithCounts,
} from "@/lib/store";
import { ADMIN_TOKEN } from "@/lib/db";

// Every operation here is admin-only. The caller proves this by sending the
// admin token (query param for GET, JSON body for POST/DELETE) — same pattern
// the leads route uses to authorize mutations.
function isAdmin(token: string | undefined | null): boolean {
  return token?.trim() === ADMIN_TOKEN;
}

// GET /api/clients?token=admin — list all clients with their lead counts.
export async function GET(request: NextRequest) {
  if (!isAdmin(request.nextUrl.searchParams.get("token"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, clients: listClientsWithCounts() });
}

interface ClientBody {
  name?: string;
  token?: string; // the new client's board token
  adminToken?: string; // proves the caller is the admin
}

// POST /api/clients — create a new client { name, token, adminToken }.
export async function POST(request: Request) {
  let body: ClientBody;
  try {
    body = (await request.json()) as ClientBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isAdmin(body.adminToken)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const name = body.name?.trim();
  const token = body.token?.trim();
  if (!name || !token) {
    return NextResponse.json(
      { error: "name and token are required" },
      { status: 400 },
    );
  }
  // Guard against a client token colliding with the admin token.
  if (token === ADMIN_TOKEN) {
    return NextResponse.json(
      { error: "Dieser Token ist reserviert." },
      { status: 400 },
    );
  }

  const client = createClient(token, name);
  if (!client) {
    return NextResponse.json(
      { error: "Dieser Token ist bereits vergeben." },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, client }, { status: 201 });
}

// DELETE /api/clients — remove a client and its leads { token, adminToken }.
export async function DELETE(request: Request) {
  let body: ClientBody;
  try {
    body = (await request.json()) as ClientBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isAdmin(body.adminToken)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const token = body.token?.trim();
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  if (!deleteClient(token)) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
