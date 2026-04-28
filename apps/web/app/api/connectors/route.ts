import { connectConnector, getConnectorState, listConnectors, setConnectorEnabled } from "@poke/connectors";
import { connectorNameSchema } from "@poke/shared";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ connectors: listConnectors() });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json() as any;
  const name = connectorNameSchema.parse(body.name);
  let state = getConnectorState(name);
  const requestedEnabled = typeof body.enabled === "boolean" ? body.enabled : state.enabled;
  
  if (typeof body.credential === "string" && body.credential.trim()) {
    state = connectConnector(name, body.credential.trim());
    if (!requestedEnabled) {
      state = setConnectorEnabled(name, false);
    }
  } else if (requestedEnabled && state.status === "available") {
    return Response.json({ error: "credential is required before enabling this connector" }, { status: 400 });
  } else {
    state = setConnectorEnabled(name, requestedEnabled);
  }
  return Response.json({ connector: state });
}
