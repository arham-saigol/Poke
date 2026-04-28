import fs from "node:fs";
import { validateAutomations } from "@poke/automations";
import { getPokePaths, readAutomations, writeJson } from "@poke/storage";
import { checkAuth } from "../auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;

  return Response.json({ automations: readAutomations() });
}

export async function POST(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;

  const body = await request.json() as any;
  const automations = validateAutomations(body.automations);
  const paths = getPokePaths();
  writeJson(paths.automations, automations);
  return Response.json({ automations });
}

export async function PUT(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;

  const body = await request.json() as any;
  const paths = getPokePaths();
  if (typeof body.content === "string") {
    try {
      validateAutomations(JSON.parse(body.content));
      fs.writeFileSync(paths.automations, body.content, "utf8");
      return Response.json({ content: body.content });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 400 });
    }
  }
  const raw = fs.readFileSync(paths.automations, "utf8");
  return Response.json({ content: raw });
}
