import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { discloseConnectorTools, childConnectorToolNames } from "@poke/connectors";
import { deleteMemory, getIndex, readMemory, writeMemory } from "@poke/memory";
import { childBaseToolNames, parentToolNames } from "@poke/shared";
import { appendLog, audit, ensureDir, getPokePaths, getSecret, readConfig, safeResolve } from "@poke/storage";
import { listSkills } from "@poke/skills";
const execFileAsync = promisify(execFile);
export function createAgentRuntime() {
    const childTools = [...childBaseToolNames, ...childConnectorToolNames()];
    return {
        parentTools: parentToolNames,
        childTools,
        parentSystemPrompt: parentPrompt(),
        childSystemPrompt: childPrompt(childTools)
    };
}
export const parentTools = {
    get_index: getIndex,
    read_memory: ({ path }) => readMemory(path),
    write_memory: (input) => writeMemory(input),
    delete_memory: ({ path }) => deleteMemory(path),
    ask_poke: async (input) => {
        appendLog("info", "agent.child_task.start", { reasoning: input.reasoning });
        if (input.reasoning !== "low") {
            appendLog("warn", "agent.child_reasoning_escalated", { reasoning: input.reasoning });
        }
        const output = await completeWithPi(input.task, input.reasoning, input.signal);
        return { output, artifacts: [] };
    },
    send_message: async (input) => {
        appendLog("info", "agent.send_message", { hasMedia: Boolean(input.media_path) });
        return { deliveredTo: "web", messageId: cryptoRandomId(), content: input.content };
    }
};
export const childTools = {
    read: ({ path: inputPath }) => {
        const file = workspacePath(inputPath);
        return { path: inputPath, content: fs.readFileSync(file, "utf8") };
    },
    write: ({ path: inputPath, content }) => {
        const file = workspacePath(inputPath);
        ensureDir(path.dirname(file));
        fs.writeFileSync(file, content, "utf8");
        audit("workspace.write", inputPath);
        return { path: inputPath, bytes: Buffer.byteLength(content) };
    },
    edit: ({ path: inputPath, instructions }) => {
        const file = workspacePath(inputPath);
        if (!fs.existsSync(file))
            throw new Error(`File does not exist: ${inputPath}`);
        audit("workspace.edit.requested", inputPath, { instructions });
        return {
            path: inputPath,
            message: "Edit request recorded. Use write with full replacement content for deterministic edits in the current runtime."
        };
    },
    bash: async ({ command, cwd, timeoutSeconds }) => {
        assertAllowedCommand(command);
        const paths = getPokePaths();
        const workingDirectory = cwd ? safeResolve(paths.workspace, cwd) : paths.workspace;
        const { stdout, stderr } = await execFileAsync(command, {
            cwd: workingDirectory,
            shell: true,
            timeout: (timeoutSeconds ?? 60) * 1000
        });
        audit("workspace.bash", workingDirectory, { command });
        return { stdout, stderr };
    },
    web_search: async ({ query, numResults }) => exaSearch(query, numResults ?? 5),
    web_fetch: async ({ url }) => webFetch(url),
    deep_research: async ({ prompt }) => {
        const results = await exaSearch(prompt, 8);
        return { prompt, report: JSON.stringify(results, null, 2) };
    },
    generate_image: async ({ prompt, outputPath }) => generateImage(prompt, outputPath),
    edit_image: async ({ prompt, imagePaths, outputPath }) => editImage(prompt, imagePaths, outputPath),
    transcribe_audio: async ({ url, keepFile }) => transcribeAudio(url, Boolean(keepFile)),
    use_github: () => discloseConnectorTools("github"),
    use_notion: () => discloseConnectorTools("notion"),
    use_posthog: () => discloseConnectorTools("posthog"),
    use_agentmail: () => discloseConnectorTools("agentmail")
};
function parentPrompt() {
    return [
        "You are Poke's parent agent. Talk to the user and delegate task work to the child agent.",
        "You may only use parent tools: get_index, read_memory, write_memory, delete_memory, ask_poke, send_message.",
        "Use ask_poke with low reasoning for more than 90% of tasks. Medium is only for complex tasks. High is only for very large or unusually complex builds.",
        "Using medium or high reasoning on basic tasks can backfire and produce worse results.",
        "You own memory decisions. The child agent does not directly mutate memory."
    ].join("\n");
}
function childPrompt(tools) {
    const skills = listSkills().filter((skill) => skill.enabled).map((skill) => `${skill.name}: ${skill.description}`);
    return [
        "You are Poke's child agent. Complete delegated tasks and return concise results to the parent.",
        `Available tools: ${tools.join(", ")}`,
        "Prefer the workspace for user-visible files. Do not mutate memory directly.",
        skills.length ? `Available skills:\n${skills.join("\n")}` : "No enabled skills are currently available."
    ].join("\n");
}
function workspacePath(inputPath) {
    const paths = getPokePaths();
    return safeResolve(paths.workspace, inputPath);
}
async function completeWithPi(task, reasoning, signal) {
    const config = readConfig();
    const childModelConfig = config.models.child;
    // Map provider names to pi-ai format
    const providerMap = {
        "openai-oauth": "openai",
        "openai-api": "openai",
        "anthropic": "anthropic",
        "google": "google",
        "openrouter": "openrouter"
    };
    const provider = providerMap[childModelConfig.provider] || "openai";
    // Get API key based on provider
    const apiKey = getSecret("openai-api-key") ?? process.env.OPENAI_API_KEY;
    if (!apiKey && provider === "openai") {
        throw new Error("OpenAI is not configured. Add an OpenAI API key or OAuth integration before running agent tasks.");
    }
    // Create model with API key to avoid race conditions from mutating process.env
    const model = getModel(provider, childModelConfig.model, apiKey ? { apiKey } : undefined);
    const runtime = createAgentRuntime();
    const systemPrompt = runtime.childSystemPrompt;
    // Build tool definitions for the child agent
    const toolDefinitions = Object.entries(childTools)
        .filter(([name]) => runtime.childTools.includes(name))
        .map(([name, impl]) => ({
        name,
        description: getToolDescription(name),
        parameters: getToolParameters(name)
    }));
    const response = await completeSimple(model, {
        systemPrompt,
        messages: [
            { role: "user", content: task, timestamp: Date.now() }
        ],
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined
    }, {
        reasoning,
        signal
    });
    return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
}
function getToolDescription(name) {
    const descriptions = {
        get_index: "Get the memory index listing all available memory files",
        read_memory: "Read a memory file by path",
        write_memory: "Write or update a memory file",
        delete_memory: "Delete a memory file",
        ask_poke: "Delegate a task to the child agent",
        send_message: "Send a message to the user",
        read: "Read a file from the workspace",
        write: "Write a file to the workspace",
        edit: "Request an edit to a workspace file",
        bash: "Execute a bash command in the workspace",
        web_search: "Search the web using Exa",
        web_fetch: "Fetch content from a URL",
        deep_research: "Perform deep research on a topic",
        generate_image: "Generate an image from a text prompt",
        edit_image: "Edit an image using reference images",
        transcribe_audio: "Transcribe audio from a URL",
        use_github: "Enable GitHub connector tools",
        use_notion: "Enable Notion connector tools",
        use_posthog: "Enable PostHog connector tools",
        use_agentmail: "Enable AgentMail connector tools"
    };
    return descriptions[name] || "";
}
function getToolParameters(name) {
    const parameters = {
        get_index: { type: "object", properties: {}, required: [] },
        read_memory: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        write_memory: { type: "object", properties: { path: { type: "string" }, title: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
        delete_memory: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        ask_poke: { type: "object", properties: { task: { type: "string" }, reasoning: { type: "string", enum: ["low", "medium", "high"] } }, required: ["task", "reasoning"] },
        send_message: { type: "object", properties: { content: { type: "string" }, media_path: { type: "string" } }, required: ["content"] },
        read: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        write: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
        edit: { type: "object", properties: { path: { type: "string" }, instructions: { type: "string" } }, required: ["path", "instructions"] },
        bash: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutSeconds: { type: "number" } }, required: ["command"] },
        web_search: { type: "object", properties: { query: { type: "string" }, numResults: { type: "number" } }, required: ["query"] },
        web_fetch: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        deep_research: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        generate_image: { type: "object", properties: { prompt: { type: "string" }, outputPath: { type: "string" } }, required: ["prompt"] },
        edit_image: { type: "object", properties: { prompt: { type: "string" }, imagePaths: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } }, required: ["prompt", "imagePaths"] },
        transcribe_audio: { type: "object", properties: { url: { type: "string" }, keepFile: { type: "boolean" } }, required: ["url"] },
        use_github: { type: "object", properties: {}, required: [] },
        use_notion: { type: "object", properties: {}, required: [] },
        use_posthog: { type: "object", properties: {}, required: [] },
        use_agentmail: { type: "object", properties: {}, required: [] }
    };
    return parameters[name] || { type: "object", properties: {}, required: [] };
}
async function generateImage(prompt, outputPath) {
    const apiKey = getSecret("vercel-ai-gateway-api-key") ?? process.env.VERCEL_AI_GATEWAY_API_KEY;
    if (!apiKey)
        throw new Error("Vercel AI Gateway API key is not configured.");
    const response = await fetch("https://ai-gateway.vercel.sh/v1/images/generations", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-image-2", prompt, response_format: "b64_json" })
    });
    if (!response.ok)
        throw new Error(`Image generation failed: ${response.status} ${await response.text()}`);
    const result = await response.json();
    const b64 = result.data?.[0]?.b64_json;
    if (!b64)
        throw new Error("Image generation response did not include image data.");
    const target = workspacePath(outputPath ?? `generated/image-${Date.now()}.png`);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, Buffer.from(b64, "base64"));
    audit("media.image.generate", target);
    return { path: target };
}
async function editImage(prompt, imagePaths, outputPath) {
    if (imagePaths.length === 0 || imagePaths.length > 2) {
        throw new Error("edit_image requires one or two reference image paths.");
    }
    const referenceSummary = imagePaths.map((imagePath) => `Reference image: ${workspacePath(imagePath)}`).join("\n");
    return generateImage(`${prompt}\n\nUse these local reference images as visual guidance:\n${referenceSummary}`, outputPath);
}
async function exaSearch(query, numResults) {
    const apiKey = getSecret("exa-api-key") ?? getSecret("exa-backup-api-key");
    if (!apiKey)
        throw new Error("Exa API key is not configured.");
    const response = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ query, numResults })
    });
    if (!response.ok)
        throw new Error(`Exa search failed: ${response.status} ${await response.text()}`);
    return response.json();
}
async function webFetch(url) {
    const response = await fetch(url, { headers: { "user-agent": "Poke/0.1" } });
    if (!response.ok)
        throw new Error(`Fetch failed: ${response.status}`);
    return { url, content: await response.text() };
}
async function transcribeAudio(url, keepFile) {
    const apiKey = getSecret("deepgram-api-key") ?? process.env.DEEPGRAM_API_KEY;
    if (!apiKey)
        throw new Error("Deepgram API key is not configured.");
    const target = workspacePath(`transcripts/audio-${Date.now()}.mp3`);
    ensureDir(path.dirname(target));
    await execFileAsync("yt-dlp", ["-x", "--audio-format", "mp3", "-o", target, url], { timeout: 10 * 60 * 1000 });
    const audio = fs.readFileSync(target);
    const response = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true", {
        method: "POST",
        headers: { authorization: `Token ${apiKey}`, "content-type": "audio/mpeg" },
        body: audio
    });
    if (!response.ok)
        throw new Error(`Deepgram transcription failed: ${response.status} ${await response.text()}`);
    const result = await response.json();
    const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    if (!keepFile)
        fs.rmSync(target, { force: true });
    return { transcript, mediaPath: keepFile ? target : undefined };
}
function cryptoRandomId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function assertAllowedCommand(command) {
    const blocked = [
        /\brm\s+-rf\s+(\/|\*|~)/i,
        /\bRemove-Item\b.*\s-Recurse\b.*\s-Force\b/i,
        /\bformat\b/i,
        /\bdiskpart\b/i,
        /\bmkfs\b/i,
        /\bshutdown\b/i,
        /\breboot\b/i
    ];
    if (blocked.some((pattern) => pattern.test(command))) {
        throw new Error("Command blocked by Poke safety policy.");
    }
}
//# sourceMappingURL=index.js.map