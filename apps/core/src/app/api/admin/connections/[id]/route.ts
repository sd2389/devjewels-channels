import {
  getAdminConnectionById,
  postAdminConnectionById,
} from "@/http/routes/admin";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return getAdminConnectionById(req, id);
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return postAdminConnectionById(req, id);
}
