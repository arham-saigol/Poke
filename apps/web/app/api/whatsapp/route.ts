import { getWhatsAppStatus } from "@poke/channels";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(getWhatsAppStatus());
}
