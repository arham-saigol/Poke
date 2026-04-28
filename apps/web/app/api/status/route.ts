import { listAuditEvents, listBackups, readConfig, readRecentLogs } from "@poke/storage";
import { getActiveSession } from "@poke/channels";
import { checkAuth } from "../auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;
  
  let config;
  let configError;
  try {
    config = readConfig();
  } catch (error) {
    config = null;
    configError = error instanceof Error ? error.message : "Failed to read config";
  }
  
  return Response.json({
    config,
    configError: configError || undefined,
    session: getActiveSession(),
    backups: listBackups(),
    audit: listAuditEvents(50),
    logs: readRecentLogs(100)
  });
}
