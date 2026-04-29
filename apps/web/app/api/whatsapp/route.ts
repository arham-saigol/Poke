import { getWhatsAppStatus } from "@poke/channels";
import { checkAuth } from "../auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;
  
  const status = getWhatsAppStatus();
  // Redact PII from response
  return Response.json({
    ...status,
    allowedNumber: status.allowedNumber ? "[REDACTED]" : null
  });
}
