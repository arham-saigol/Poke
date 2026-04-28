import { connectConnector, getConnectorState, listConnectors, setConnectorEnabled } from "@poke/connectors";
import { connectorNameSchema } from "@poke/shared";
import { checkAuth } from "../auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;

  return Response.json({ connectors: listConnectors() });
}

export async function POST(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;

  try {
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
  } catch (error) {
    if (isConnectorInputError(error)) {
      return Response.json({ error: error instanceof Error ? error.message : "invalid input" }, { status: 400 });
    }
    throw error;
  }
}

function isConnectorInputError(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }
  if (error instanceof Error && error.name === "ZodError") {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  const clientPhrases = [
    "credential is required",
    "credentials are missing",
    "invalid credential",
    "invalid credentials",
    "invalid api key",
    "invalid token",
    "invalid oauth token",
    "invalid authorization"
  ];
  return clientPhrases.some((phrase) => message.includes(phrase));
}
