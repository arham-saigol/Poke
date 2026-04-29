import { getActiveSession, receiveMessage } from "@poke/channels";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(getActiveSession());
}

export async function POST(request: Request): Promise<Response> {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  
  // Validate content and mediaPath
  if (body.content !== undefined && typeof body.content !== "string") {
    return Response.json({ error: "content must be a string" }, { status: 400 });
  }
  if (body.mediaPath !== undefined && typeof body.mediaPath !== "string") {
    return Response.json({ error: "mediaPath must be a string" }, { status: 400 });
  }
  
  const content = String(body.content ?? "");
  const mediaPath = body.mediaPath;
  
  return Response.json(await receiveMessage({ channel: "web", content, mediaPath }));
}
