import { listAuditEvents, listBackups, readConfig, readRecentLogs } from "@poke/storage";
import { getActiveSession } from "@poke/channels";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({
    config: readConfig(),
    session: getActiveSession(),
    backups: listBackups(),
    audit: listAuditEvents(50),
    logs: readRecentLogs(100)
  });
}
