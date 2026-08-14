import { assertAdminRequest, jsonError } from "@/security/dashboardAuth";
import { listChannelsCustomers } from "@/integrations/deverp/client";

const Q_MAX_LEN = 100;

export async function GET(req: Request) {
  try {
    await assertAdminRequest(req);
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    if (q.length > Q_MAX_LEN) {
      return Response.json({ error: "Query is too long." }, { status: 400 });
    }
    const offsetRaw = url.searchParams.get("offset");
    const offset = offsetRaw ? Number(offsetRaw) : 0;
    const data = await listChannelsCustomers({
      q,
      limit: 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return Response.json(data);
  } catch (err) {
    return jsonError(err);
  }
}
