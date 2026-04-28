import { getActiveSession, receiveMessage } from "@poke/channels";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(getActiveSession());
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json() as any;
  return Response.json(await receiveMessage({ channel: "web", content: String(body.content ?? ""), mediaPath: body.mediaPath }));
}
