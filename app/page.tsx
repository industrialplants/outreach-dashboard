import { cookies } from "next/headers";
import { ADMIN_TOKEN } from "@/lib/db";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import {
  computeKpis,
  getClient,
  listClients,
  listLeads,
  weeklyReport,
} from "@/lib/store";
import Dashboard from "./components/Dashboard";
import LoginForm from "./components/LoginForm";

// Async searchParams — required in Next.js 16 (see AGENTS.md / v16 breaking changes).
export default async function Page(props: PageProps<"/">) {
  const searchParams = await props.searchParams;

  const rawToken = searchParams.token;
  const token = (Array.isArray(rawToken) ? rawToken[0] : rawToken)?.trim();

  const rawClient = searchParams.client;
  const clientParam = (
    Array.isArray(rawClient) ? rawClient[0] : rawClient
  )?.trim();

  // Admin gets in either the old way (?token=admin link, unchanged) or via a
  // real login — /api/login signs a session whose payload is the ADMIN_TOKEN
  // sentinel for an admin login, so both paths converge here.
  const cookieStore = await cookies();
  const sessionValue = verifySessionToken(cookieStore.get(SESSION_COOKIE)?.value);
  const isAdmin = token === ADMIN_TOKEN || sessionValue === ADMIN_TOKEN;

  if (isAdmin) {
    const clients = await listClients();
    if (clients.length === 0) {
      return (
        <Dashboard
          role="admin"
          adminToken={ADMIN_TOKEN}
          clients={[]}
          selected={null}
          leads={[]}
          kpis={null}
          report={[]}
        />
      );
    }
    const selected = clients.find((c) => c.token === clientParam) ?? clients[0];
    const [leads, kpis, report] = await Promise.all([
      listLeads(selected.token),
      computeKpis(selected.token),
      weeklyReport(selected.token),
    ]);
    return (
      <Dashboard
        role="admin"
        adminToken={ADMIN_TOKEN}
        clients={clients}
        selected={selected}
        leads={leads}
        kpis={kpis}
        report={report}
      />
    );
  }

  // Clients no longer get in via a link token — only via a real login. Any
  // ?token= value that isn't the admin token is simply ignored below; the
  // session cookie set by /api/login is the only way in from here on.
  const client = sessionValue ? await getClient(sessionValue) : undefined;

  if (!client) {
    return <LoginForm />;
  }

  const [leads, kpis, report] = await Promise.all([
    listLeads(client.token),
    computeKpis(client.token),
    weeklyReport(client.token),
  ]);

  return (
    <Dashboard
      role="client"
      adminToken={null}
      clients={[client]}
      selected={client}
      leads={leads}
      kpis={kpis}
      report={report}
    />
  );
}
