import { getWhatsAppStatus } from "@poke/channels";
import { readConfig, updateSecrets, writeConfig } from "@poke/storage";
import { checkAuth } from "../auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;

  return Response.json({ config: readConfig(), whatsapp: getWhatsAppStatus(), profile: { name: "Owner" } });
}

export async function POST(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;

  const body = await request.json() as any;
  const config = readConfig();
  if (typeof body.allowedWhatsAppNumber === "string") {
    config.channels.whatsapp.allowedNumber = body.allowedWhatsAppNumber || null;
  }
  if (typeof body.whatsappEnabled === "boolean") {
    config.channels.whatsapp.enabled = body.whatsappEnabled;
  }
  const secretUpdates: Record<string, string | null | undefined> = {
    "exa-api-key": typeof body.exaApiKey === "string" ? body.exaApiKey || null : undefined,
    "exa-backup-api-key": typeof body.exaBackupApiKey === "string" ? body.exaBackupApiKey || null : undefined,
    "vercel-ai-gateway-api-key": typeof body.vercelAiGatewayApiKey === "string" ? body.vercelAiGatewayApiKey || null : undefined,
    "deepgram-api-key": typeof body.deepgramApiKey === "string" ? body.deepgramApiKey || null : undefined,
    "openai-api-key": typeof body.openaiApiKey === "string" ? body.openaiApiKey || null : undefined
  };
  updateSecrets(secretUpdates);
  writeConfig(config);
  return Response.json({ config, whatsapp: getWhatsAppStatus() });
}
