import { NextResponse } from "next/server";
import { verifyClientLogin } from "@/lib/store";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { ADMIN_TOKEN, ADMIN_USERNAME, ADMIN_PASSWORD } from "@/lib/db";

interface LoginBody {
  username?: string;
  password?: string;
}

// POST /api/login { username, password } — sets a session cookie on success.
export async function POST(request: Request) {
  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = body.username?.trim() ?? "";
  const password = body.password ?? "";
  if (!username || !password) {
    return NextResponse.json(
      { error: "Benutzername und Passwort erforderlich." },
      { status: 400 },
    );
  }

  // Admin login: same session mechanism, but the signed payload is the
  // ADMIN_TOKEN sentinel instead of a client_token — page.tsx recognizes it.
  if (
    username.toLowerCase() === ADMIN_USERNAME.toLowerCase() &&
    password === ADMIN_PASSWORD
  ) {
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, createSessionToken(ADMIN_TOKEN), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

  const client = await verifyClientLogin(username, password);
  if (!client) {
    return NextResponse.json(
      { error: "Benutzername oder Passwort ist falsch." },
      { status: 401 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, createSessionToken(client.token), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
