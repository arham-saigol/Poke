import fs from "node:fs";
import { validateAutomations } from "@poke/automations";
import { getPokePaths, readAutomations, writeJson } from "@poke/storage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ automations: readAutomations() });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json() as any;
  const automations = validateAutomations(body.automations);
  const paths = getPokePaths();
  writeJson(paths.automations, automations);
  return Response.json({ automations });
}

export async function PUT(request: Request): Promise<Response> {
  const body = await request.json() as any;
  const paths = getPokePaths();
  const raw = fs.readFileSync(paths.automations, "utf8");
  return Response.json({ content: body.content ?? raw });
}
