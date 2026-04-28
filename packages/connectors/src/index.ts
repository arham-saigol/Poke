import { getSecret, setSecret } from "@poke/storage";
import type { ConnectorName, ConnectorState, ToolName } from "@poke/shared";

type ConnectorDefinition = {
  name: ConnectorName;
  displayName: string;
  authType: "oauth" | "api_key";
  toolName: Extract<ToolName, "use_github" | "use_notion" | "use_posthog" | "use_agentmail">;
  tools: Array<{ name: string; description: string }>;
};

export const connectorRegistry: Record<ConnectorName, ConnectorDefinition> = {
  github: {
    name: "github",
    displayName: "GitHub",
    authType: "oauth",
    toolName: "use_github",
    tools: [
      { name: "list_repositories", description: "List repositories available to the connected GitHub account." },
      { name: "fetch_file", description: "Read a file from a repository by owner, repo, path, and ref." },
      { name: "create_pull_request", description: "Open a pull request with prepared branch changes." }
    ]
  },
  notion: {
    name: "notion",
    displayName: "Notion",
    authType: "oauth",
    toolName: "use_notion",
    tools: [
      { name: "search_pages", description: "Search connected Notion pages and databases." },
      { name: "read_page", description: "Read a Notion page by id." },
      { name: "append_block", description: "Append content blocks to a Notion page." }
    ]
  },
  posthog: {
    name: "posthog",
    displayName: "PostHog",
    authType: "api_key",
    toolName: "use_posthog",
    tools: [
      { name: "query_insights", description: "Query PostHog insights and product analytics." },
      { name: "list_projects", description: "List accessible PostHog projects." }
    ]
  },
  agentmail: {
    name: "agentmail",
    displayName: "AgentMail",
    authType: "api_key",
    toolName: "use_agentmail",
    tools: [
      { name: "send_email", description: "Send an email through AgentMail." },
      { name: "list_inbox", description: "List recent AgentMail inbox messages." }
    ]
  }
};

export function listConnectors(): ConnectorState[] {
  return (Object.keys(connectorRegistry) as ConnectorName[]).map(getConnectorState);
}

export function getConnectorState(name: ConnectorName): ConnectorState {
  const definition = connectorRegistry[name];
  const secret = getSecret(secretName(name));
  const enabled = getSecret(enabledName(name)) === "true";
  return {
    name,
    displayName: definition.displayName,
    authType: definition.authType,
    status: secret ? enabled ? "enabled" : "disabled" : "available",
    enabled,
    connectedAt: getSecret(connectedAtName(name)),
    error: null
  };
}

export function connectConnector(name: ConnectorName, tokenOrKey: string): ConnectorState {
  setSecret(secretName(name), tokenOrKey);
  setSecret(enabledName(name), "true");
  setSecret(connectedAtName(name), new Date().toISOString());
  return getConnectorState(name);
}

export function setConnectorEnabled(name: ConnectorName, enabled: boolean): ConnectorState {
  // If enabling, validate that credentials exist
  if (enabled) {
    const state = getConnectorState(name);
    const secret = getSecret(secretName(name));
    
    if (!secret) {
      throw new Error(`Cannot enable ${state.displayName} connector: credentials are missing. Please connect the connector first.`);
    }
  }
  
  setSecret(enabledName(name), String(enabled));
  return getConnectorState(name);
}

export function discloseConnectorTools(name: ConnectorName): {
  connector: ConnectorName;
  toolName: string;
  tools: Array<{ name: string; description: string }>;
  instructions: string;
} {
  const state = getConnectorState(name);
  if (state.status !== "enabled") {
    throw new Error(`${state.displayName} connector is not enabled.`);
  }
  const definition = connectorRegistry[name];
  return {
    connector: name,
    toolName: definition.toolName,
    tools: definition.tools,
    instructions:
      "Use these connector operations only when the user task clearly requires this connector. After disclosure, keep the descriptions in context for the current task."
  };
}

export function childConnectorToolNames(): ToolName[] {
  return (Object.keys(connectorRegistry) as ConnectorName[])
    .filter((name) => getConnectorState(name).status === "enabled")
    .map((name) => connectorRegistry[name].toolName);
}

function secretName(name: ConnectorName): string {
  return `connector.${name}.credential`;
}

function enabledName(name: ConnectorName): string {
  return `connector.${name}.enabled`;
}

function connectedAtName(name: ConnectorName): string {
  return `connector.${name}.connectedAt`;
}
