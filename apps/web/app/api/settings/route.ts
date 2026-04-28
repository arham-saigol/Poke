import { getWhatsAppStatus } from "@poke/channels";
import { deleteSecret, readConfig, setSecret, writeConfig } from "@poke/storage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ config: readConfig(), whatsapp: getWhatsAppStatus(), profile: { name: "Owner" } });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json() as any;
  const config = readConfig();
  if (typeof body.allowedWhatsAppNumber === "string") {
    config.channels.whatsapp.allowedNumber = body.allowedWhatsAppNumber || null;
  }
  if (typeof body.whatsappEnabled === "boolean") {
    config.channels.whatsapp.enabled = body.whatsappEnabled;
  }
  if (typeof body.exaApiKey === "string") {
    body.exaApiKey ? setSecret("exa-api-key", body.exaApiKey) : deleteSecret("exa-api-key");
  }
  if (typeof body.exaBackupApiKey === "string") {
    body.exaBackupApiKey ? setSecret("exa-backup-api-key", body.exaBackupApiKey) : deleteSecret("exa-backup-api-key");
  }
  if (typeof body.vercelAiGatewayApiKey === "string") {
    body.vercelAiGatewayApiKey ? setSecret("vercel-ai-gateway-api-key", body.vercelAiGatewayApiKey) : deleteSecret("vercel-ai-gateway-api-key");
  }
  if (typeof body.deepgramApiKey === "string") {
    body.deepgramApiKey ? setSecret("deepgram-api-key", body.deepgramApiKey) : deleteSecret("deepgram-api-key");
  }
  if (typeof body.openaiApiKey === "string") {
    body.openaiApiKey ? setSecret("openai-api-key", body.openaiApiKey) : deleteSecret("openai-api-key");
  }
  writeConfig(config);
  return Response.json({ config, whatsapp: getWhatsAppStatus() });
}
