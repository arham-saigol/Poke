import { z } from "zod";

export const reasoningLevelSchema = z.enum(["low", "medium", "high"]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

export const modelConfigSchema = z.object({
  provider: z.enum(["openai-oauth", "openai-api", "anthropic", "google", "openrouter"]),
  model: z.string().min(1),
  reasoning: reasoningLevelSchema
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const pokeConfigSchema = z.object({
  version: z.literal(1),
  instanceId: z.string().min(1),
  publicBaseUrl: z.string().url().nullable(),
  timezone: z.string().min(1),
  paths: z.object({
    home: z.string().min(1),
    workspace: z.string().min(1),
    memory: z.string().min(1),
    skills: z.string().min(1),
    logs: z.string().min(1)
  }),
  auth: z.object({
    webSessionSecretRef: z.string().min(1),
    cloudflareAccessEnabled: z.boolean(),
    allowedEmail: z.string().email().nullable()
  }),
  models: z.object({
    parent: modelConfigSchema,
    child: modelConfigSchema,
    memoryCleanup: z.object({
      consolidator: modelConfigSchema,
      advisory: modelConfigSchema,
      judge: modelConfigSchema
    })
  }),
  channels: z.object({
    web: z.object({ enabled: z.literal(true) }),
    whatsapp: z.object({
      enabled: z.boolean(),
      adapter: z.literal("baileys"),
      allowedNumber: z.string().nullable()
    })
  })
});
export type PokeConfig = z.infer<typeof pokeConfigSchema>;

export const automationSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  enabled: z.boolean(),
  kind: z.enum(["recurring", "one_time"]),
  schedule: z.discriminatedUnion("type", [
    z.object({ type: z.literal("cron"), value: z.string().min(1), timezone: z.string().min(1) }),
    z.object({ type: z.literal("at"), value: z.string().datetime(), timezone: z.string().min(1) })
  ]),
  action: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("command"),
      command: z.string().min(1),
      cwd: z.string().optional(),
      timeoutSeconds: z.number().int().positive().optional()
    }),
    z.object({
      type: z.literal("prompt"),
      prompt: z.string().min(1),
      reasoning: reasoningLevelSchema.optional()
    })
  ]),
  createdBy: z.enum(["system", "user", "agent"]),
  updatedAt: z.string().datetime(),
  lastRunAt: z.string().datetime().optional(),
  nextRunAt: z.string().datetime().optional()
});
export type Automation = z.infer<typeof automationSchema>;

export const automationsFileSchema = z.array(automationSchema);
export type AutomationsFile = z.infer<typeof automationsFileSchema>;

export const connectorNameSchema = z.enum(["github", "notion", "posthog", "agentmail"]);
export type ConnectorName = z.infer<typeof connectorNameSchema>;

export const connectorStateSchema = z.object({
  name: connectorNameSchema,
  displayName: z.string().min(1),
  authType: z.enum(["oauth", "api_key"]),
  status: z.enum(["available", "connected", "enabled", "disabled", "error"]),
  enabled: z.boolean(),
  connectedAt: z.string().datetime().nullable(),
  error: z.string().nullable()
});
export type ConnectorState = z.infer<typeof connectorStateSchema>;

export const skillMetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  source: z.enum(["bundled", "user"]),
  enabled: z.boolean(),
  path: z.string().min(1)
});
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;

export const agentRoleSchema = z.enum(["parent", "child"]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const toolNameSchema = z.enum([
  "get_index",
  "read_memory",
  "write_memory",
  "delete_memory",
  "ask_poke",
  "send_message",
  "read",
  "write",
  "edit",
  "bash",
  "web_search",
  "web_fetch",
  "deep_research",
  "generate_image",
  "edit_image",
  "transcribe_audio",
  "use_github",
  "use_notion",
  "use_posthog",
  "use_agentmail"
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const parentToolNames = [
  "get_index",
  "read_memory",
  "write_memory",
  "delete_memory",
  "ask_poke",
  "send_message"
] as const satisfies readonly ToolName[];

export const childBaseToolNames = [
  "read",
  "write",
  "edit",
  "bash",
  "web_search",
  "web_fetch",
  "deep_research",
  "generate_image",
  "edit_image",
  "transcribe_audio"
] as const satisfies readonly ToolName[];

export const daemonStatusSchema = z.object({
  running: z.boolean(),
  pid: z.number().int().positive().nullable(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  startedAt: z.string().datetime().nullable(),
  home: z.string(),
  publicBaseUrl: z.string().nullable(),
  logFile: z.string()
});
export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

export const channelSchema = z.enum(["web", "whatsapp", "system"]);
export type Channel = z.infer<typeof channelSchema>;

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  channel: channelSchema,
  content: z.string(),
  mediaPath: z.string().optional(),
  createdAt: z.string().datetime()
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const activeSessionSchema = z.object({
  id: z.string().min(1),
  reasoning: reasoningLevelSchema,
  status: z.enum(["idle", "running", "aborted"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  messages: z.array(chatMessageSchema)
});
export type ActiveSession = z.infer<typeof activeSessionSchema>;

export const defaultModels = {
  parent: { provider: "openai-oauth", model: "gpt-5.5", reasoning: "low" },
  child: { provider: "openai-oauth", model: "gpt-5.5", reasoning: "low" },
  memoryCleanup: {
    consolidator: { provider: "openai-oauth", model: "gpt-5.4-mini", reasoning: "high" },
    advisory: { provider: "openai-oauth", model: "gpt-5.4-mini", reasoning: "high" },
    judge: { provider: "openai-oauth", model: "gpt-5.5", reasoning: "medium" }
  }
} satisfies PokeConfig["models"];
