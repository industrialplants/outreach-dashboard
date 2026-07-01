import { ADMIN_TOKEN } from "@/lib/db";
import {
  computeKpis,
  getClient,
  listClients,
  listLeads,
  weeklyReport,
} from "@/lib/store";
import Dashboard from "./components/Dashboard";
import AccessGate from "./components/AccessGate";

// Async searchParams — required in Next.js 16 (see AGENTS.md / v16 breaking changes).
export default async function Page(props: PageProps<"/">) {
  const searchParams = await props.searchParams;

  const rawToken = searchParams.token;
  const token = (Array.isArray(rawToken) ? rawToken[0] : rawToken)?.trim();

  const rawClient = searchParams.client;
  const clientParam = (
    Array.isArray(rawClient) ? rawClient[0] : rawClient
  )?.trim();

  if (!token) {
    return <AccessGate reason="missing" />;
  }

  const isAdmin = token === ADMIN_TOKEN;

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

  const client = await getClient(token);
  if (!client) {
    return <AccessGate reason="invalid" />;
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
