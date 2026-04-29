import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
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
        const { executable, args, canonical } = parseAllowedCommand(command);
        const paths = getPokePaths();
        const workingDirectory = cwd ? safeResolve(paths.workspace, cwd) : paths.workspace;
        const { stdout, stderr } = await execFileAsync(executable, args, {
            cwd: workingDirectory,
            timeout: (timeoutSeconds ?? 60) * 1000
        });
        audit("workspace.bash", workingDirectory, { command: canonical });
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
    const provider = providerMap[childModelConfig.provider] ?? "openai";
    const apiKey = resolveModelApiKey(provider);
    const model = getModel(provider, childModelConfig.model);
    if (!model) {
        throw new Error(`Unsupported ${provider} model: ${childModelConfig.model}`);
    }
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
    const messages = [
        { role: "user", content: task, timestamp: Date.now() }
    ];
    const collectedText = [];
    // Cap iterations so a malfunctioning model can't loop forever.
    const maxIterations = 16;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const response = await completeSimple(model, {
            systemPrompt,
            messages,
            tools: toolDefinitions.length > 0 ? toolDefinitions : undefined
        }, {
            reasoning,
            signal,
            apiKey
        });
        const blocks = Array.isArray(response.content) ? response.content : [];
        for (const block of blocks) {
            if (block?.type === "text" && typeof block.text === "string") {
                collectedText.push(block.text);
            }
        }
        const toolCalls = blocks.filter((block) => block?.type === "toolCall");
        if (toolCalls.length === 0) {
            break;
        }
        // Append the assistant message so the model sees its prior tool calls.
        messages.push(response);
        for (const call of toolCalls) {
            const impl = childTools[call.name];
            let resultText;
            let isError = false;
            if (!impl || !runtime.childTools.includes(call.name)) {
                resultText = `Tool not available: ${call.name}`;
                isError = true;
            }
            else {
                try {
                    const value = await impl(call.arguments ?? {});
                    resultText = typeof value === "string" ? value : JSON.stringify(value);
                }
                catch (error) {
                    resultText = error instanceof Error ? error.message : String(error);
                    isError = true;
                }
            }
            messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: "text", text: resultText }],
                isError,
                timestamp: Date.now()
            });
        }
    }
    return collectedText.join("\n").trim();
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
    return requestImageGeneration(prompt, outputPath);
}
async function generateImageWithImages(prompt, images, outputPath) {
    if (images.length === 0) {
        throw new Error("At least one reference image is required.");
    }
    return requestImageGeneration(prompt, outputPath, images);
}
async function requestImageGeneration(prompt, outputPath, images = []) {
    const apiKey = getSecret("vercel-ai-gateway-api-key") ?? process.env.VERCEL_AI_GATEWAY_API_KEY;
    if (!apiKey)
        throw new Error("Vercel AI Gateway API key is not configured.");
    const endpoint = images.length > 0
        ? "https://ai-gateway.vercel.sh/v1/images/edits"
        : "https://ai-gateway.vercel.sh/v1/images/generations";
    const body = images.length > 0
        ? {
            model: "openai/gpt-image-2",
            prompt,
            images: images.map((image) => ({
                image_url: `data:${image.mime};base64,${image.data}`
            })),
            response_format: "b64_json"
        }
        : {
            model: "openai/gpt-image-2",
            prompt,
            response_format: "b64_json"
        };
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body)
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
    const images = await Promise.all(imagePaths.map(loadWorkspaceImage));
    return generateImageWithImages(prompt, images, outputPath);
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
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;
async function webFetch(url) {
    const { url: parsedUrl, resolvedAddress, family } = await validatePublicHttpsUrl(url);
    return await new Promise((resolve, reject) => {
        const port = parsedUrl.port ? Number(parsedUrl.port) : 443;
        let settled = false;
        let timeoutTimer = null;
        let activeResponse = null;
        const cleanup = () => {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
            }
        };
        const settleReject = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            try {
                activeResponse?.destroy();
            }
            catch { /* ignore */ }
            try {
                request.destroy();
            }
            catch { /* ignore */ }
            reject(error);
        };
        const settleResolve = (value) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const request = https.request({
            host: parsedUrl.hostname,
            port,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method: "GET",
            headers: {
                "user-agent": "Poke/0.1",
                host: parsedUrl.host
            },
            servername: parsedUrl.hostname,
            // Pin the resolved IP so DNS rebinding between validation and connect cannot
            // redirect the request to a private/reserved address.
            lookup: (_hostname, _options, callback) => {
                callback(null, resolvedAddress, family);
            }
        }, (response) => {
            activeResponse = response;
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
                response.resume();
                settleReject(new Error(`Fetch failed: ${status}`));
                return;
            }
            const chunks = [];
            let received = 0;
            response.on("data", (chunk) => {
                received += chunk.length;
                if (received > MAX_FETCH_BYTES) {
                    settleReject(new Error(`Fetch failed: response exceeded ${MAX_FETCH_BYTES} bytes`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => {
                settleResolve({ url: parsedUrl.toString(), content: Buffer.concat(chunks).toString("utf8") });
            });
            response.on("error", settleReject);
        });
        request.on("error", settleReject);
        timeoutTimer = setTimeout(() => {
            settleReject(new Error(`Fetch failed: timed out after ${FETCH_TIMEOUT_MS}ms`));
        }, FETCH_TIMEOUT_MS);
        request.end();
    });
}
async function transcribeAudio(url, keepFile) {
    const apiKey = getSecret("deepgram-api-key") ?? process.env.DEEPGRAM_API_KEY;
    if (!apiKey)
        throw new Error("Deepgram API key is not configured.");
    const sourceUrl = validateHttpUrl(url, "transcribe_audio");
    await assertPublicHttpHostname(sourceUrl, "transcribe_audio");
    const target = workspacePath(`transcripts/audio-${Date.now()}.mp3`);
    ensureDir(path.dirname(target));
    await execFileAsync("yt-dlp", ["-x", "--audio-format", "mp3", "-o", target, sourceUrl], { timeout: 10 * 60 * 1000 });
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
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString("hex");
}
export function assertAllowedCommand(command) {
    parseAllowedCommand(command);
}
export function parseAllowedCommand(command) {
    const normalized = command.trim();
    if (!normalized) {
        throw new Error("Command is required.");
    }
    if (/[`]|(?:\$\()|[|&;<>]/.test(normalized)) {
        throw new Error("Command contains disallowed shell syntax.");
    }
    if (/\b(?:base64|certutil|openssl)\b.*\b(?:-d|--decode|decode|frombase64string)\b/i.test(normalized)) {
        throw new Error("Encoded command payloads are not allowed.");
    }
    const tokens = tokenizeCommand(normalized);
    if (tokens.length === 0) {
        throw new Error("Command is required.");
    }
    const [executable, ...args] = tokens;
    if (/[\\/:\0]/.test(executable)) {
        throw new Error("Command must use an approved executable name.");
    }
    if (!ALLOWED_COMMANDS.has(executable)) {
        throw new Error(`Command is not permitted: ${executable}`);
    }
    if (SHELL_EXECUTABLES.has(executable)) {
        throw new Error(`Shell interpreters are not permitted: ${executable}`);
    }
    validateCommandArguments(executable, args);
    return { executable, args, canonical: [executable, ...args].join(" ") };
}
function resolveModelApiKey(provider) {
    const configured = {
        openai: {
            secret: "openai-api-key",
            env: "OPENAI_API_KEY",
            label: "OpenAI"
        },
        anthropic: {
            secret: "anthropic-api-key",
            env: "ANTHROPIC_API_KEY",
            label: "Anthropic"
        },
        google: {
            secret: "google-api-key",
            env: "GOOGLE_API_KEY",
            label: "Google"
        },
        openrouter: {
            secret: "openrouter-api-key",
            env: "OPENROUTER_API_KEY",
            label: "OpenRouter"
        }
    }[provider];
    const apiKey = getSecret(configured.secret) ?? process.env[configured.env];
    if (!apiKey) {
        throw new Error(`${configured.label} is not configured. Set ${configured.env} or store ${configured.secret} before running agent tasks.`);
    }
    return apiKey;
}
async function loadWorkspaceImage(imagePath) {
    const file = workspacePath(imagePath);
    const mime = mimeTypeForImage(file);
    const buffer = await fs.promises.readFile(file);
    return {
        name: path.basename(file),
        mime,
        data: buffer.toString("base64")
    };
}
function mimeTypeForImage(file) {
    const extension = path.extname(file).toLowerCase();
    const mime = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif"
    }[extension];
    if (!mime) {
        throw new Error(`Unsupported image type for edit_image: ${extension || "unknown"}`);
    }
    return mime;
}
async function validatePublicHttpsUrl(rawUrl) {
    const parsed = new URL(validateHttpUrl(rawUrl, "web_fetch"));
    if (parsed.protocol !== "https:") {
        throw new Error("web_fetch only allows https URLs.");
    }
    if (parsed.username || parsed.password) {
        throw new Error("web_fetch does not allow embedded credentials.");
    }
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
        throw new Error(`web_fetch does not allow local targets: ${hostname}`);
    }
    const resolvedAddresses = net.isIP(hostname)
        ? [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }]
        : await dns.lookup(hostname, { all: true, verbatim: true });
    if (resolvedAddresses.length === 0) {
        throw new Error(`web_fetch could not resolve ${hostname}`);
    }
    const blockedAddress = resolvedAddresses.find((entry) => isPrivateOrReservedAddress(entry.address));
    if (blockedAddress) {
        throw new Error(`web_fetch blocked private or reserved address ${blockedAddress.address} for ${hostname}`);
    }
    // Pin the first validated address so the subsequent fetch cannot be redirected to
    // a different (potentially private) IP via DNS rebinding between validation and connect.
    const pinned = resolvedAddresses[0];
    return { url: parsed, resolvedAddress: pinned.address, family: pinned.family };
}
async function assertPublicHttpHostname(rawUrl, toolName) {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
        throw new Error(`${toolName} does not allow local targets: ${hostname}`);
    }
    const resolvedAddresses = net.isIP(hostname)
        ? [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }]
        : await dns.lookup(hostname, { all: true, verbatim: true });
    if (resolvedAddresses.length === 0) {
        throw new Error(`${toolName} could not resolve ${hostname}`);
    }
    const blockedAddress = resolvedAddresses.find((entry) => isPrivateOrReservedAddress(entry.address));
    if (blockedAddress) {
        throw new Error(`${toolName} blocked private or reserved address ${blockedAddress.address} for ${hostname}`);
    }
}
function validateHttpUrl(rawUrl, toolName) {
    const normalized = rawUrl.trim();
    if (!normalized) {
        throw new Error(`${toolName} requires a URL.`);
    }
    if (normalized.startsWith("-")) {
        throw new Error(`${toolName} URL must not start with '-'.`);
    }
    let parsed;
    try {
        parsed = new URL(normalized);
    }
    catch {
        throw new Error(`${toolName} requires an absolute http or https URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${toolName} only allows http and https URLs.`);
    }
    return parsed.toString();
}
function tokenizeCommand(command) {
    const tokens = [];
    let current = "";
    let quote = null;
    let escaping = false;
    for (const character of command) {
        if (escaping) {
            current += character;
            escaping = false;
            continue;
        }
        if (quote === "'") {
            if (character === "'") {
                quote = null;
            }
            else {
                current += character;
            }
            continue;
        }
        if (quote === "\"") {
            if (character === "\"") {
                quote = null;
            }
            else if (character === "\\") {
                escaping = true;
            }
            else {
                current += character;
            }
            continue;
        }
        if (character === "\\") {
            escaping = true;
            continue;
        }
        if (character === "'" || character === "\"") {
            quote = character;
            continue;
        }
        if (/\s/.test(character)) {
            if (current) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += character;
    }
    if (escaping || quote) {
        throw new Error("Command contains an unterminated quote or escape sequence.");
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}
function validateCommandArguments(executable, args) {
    for (const arg of args) {
        if (arg.includes("\0")) {
            throw new Error("Command arguments may not contain null bytes.");
        }
        if (!arg.startsWith("-") && isUnsafePathToken(arg)) {
            throw new Error(`Command argument is not allowed: ${arg}`);
        }
    }
    switch (executable) {
        case "git":
            validateSubcommand(executable, args, ALLOWED_GIT_SUBCOMMANDS);
            return;
        case "npm":
        case "pnpm":
            validateSubcommand(executable, args, ALLOWED_PACKAGE_MANAGER_SUBCOMMANDS);
            return;
        case "node":
            validateNodeCommand(args);
            return;
        case "python":
        case "python3":
            validatePythonCommand(args);
            return;
        case "sed":
            validateSedCommand(args);
            return;
        case "find":
            validateFindCommand(args);
            return;
        case "cat":
            validateCatCommand(args);
            return;
        case "pytest":
            return;
        default:
            return;
    }
}
function validateSedCommand(args) {
    for (const arg of args) {
        if (arg === "--in-place" || arg.startsWith("--in-place=")) {
            throw new Error("sed in-place edit flags are not permitted.");
        }
        // Short-style: -i, -i.bak, or combined short flags containing i (e.g. -ni, -ie)
        if (/^-[a-zA-Z]*i/.test(arg)) {
            throw new Error("sed in-place edit flags are not permitted.");
        }
    }
}
function validateFindCommand(args) {
    const forbiddenActions = new Set([
        "-exec",
        "-execdir",
        "-ok",
        "-okdir",
        "-delete",
        "-fprint",
        "-fprintf",
        "-fls"
    ]);
    for (const arg of args) {
        if (forbiddenActions.has(arg)) {
            throw new Error(`find action is not permitted: ${arg}`);
        }
    }
}
function validateCatCommand(args) {
    for (const arg of args) {
        if (arg.startsWith("-"))
            continue;
        if (/^\/dev(\/|$)/i.test(arg) || /^\/proc(\/|$)/i.test(arg) || /^\/sys(\/|$)/i.test(arg)) {
            throw new Error(`cat target is not permitted: ${arg}`);
        }
        if (isUnsafePathToken(arg)) {
            throw new Error(`cat target is not permitted: ${arg}`);
        }
    }
}
function validateSubcommand(executable, args, allowedSubcommands) {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (!subcommand) {
        throw new Error(`${executable} requires an allowed subcommand.`);
    }
    if (!allowedSubcommands.has(subcommand)) {
        throw new Error(`${executable} subcommand is not permitted: ${subcommand}`);
    }
}
function validateNodeCommand(args) {
    if (args.length === 1 && args[0] === "--version") {
        return;
    }
    if (args.length === 0) {
        throw new Error("node requires a script path.");
    }
    if (args.some((arg) => ["-e", "--eval", "-p", "--print", "-i", "--interactive", "--input-type", "-r", "--require"].includes(arg))) {
        throw new Error("node inline execution flags are not permitted.");
    }
    const script = args.find((arg) => !arg.startsWith("-"));
    if (!script || !/\.(?:[cm]?js|ts)$/i.test(script)) {
        throw new Error("node requires a .js, .mjs, .cjs, or .ts script path.");
    }
}
function validatePythonCommand(args) {
    if (args.length === 0) {
        throw new Error("python requires a script path.");
    }
    if (args.some((arg) => arg === "-c" || arg === "-m")) {
        throw new Error("python inline or module execution is not permitted.");
    }
    const script = args.find((arg) => !arg.startsWith("-"));
    if (!script || !/\.py$/i.test(script)) {
        throw new Error("python requires a .py script path.");
    }
}
function isUnsafePathToken(token) {
    if (/^(?:[a-zA-Z]:[\\/]|[\\/]|~[\\/])/.test(token)) {
        return true;
    }
    return token.split(/[\\/]+/).some((segment) => segment === "..");
}
function isPrivateOrReservedAddress(address) {
    const mappedIpv4 = extractMappedIpv4(address);
    if (mappedIpv4) {
        return isPrivateOrReservedIpv4(mappedIpv4);
    }
    if (net.isIPv4(address)) {
        return isPrivateOrReservedIpv4(address);
    }
    if (net.isIPv6(address)) {
        return isPrivateOrReservedIpv6(address);
    }
    return true;
}
function extractMappedIpv4(address) {
    const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    return match?.[1] ?? null;
}
function isPrivateOrReservedIpv4(address) {
    const octets = address.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127)
        return true;
    if (a === 100 && b >= 64 && b <= 127)
        return true;
    if (a === 169 && b === 254)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 192 && b === 0)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 198 && (b === 18 || b === 19))
        return true;
    if (a === 198 && b === 51)
        return true;
    if (a === 203 && b === 0)
        return true;
    if (a >= 224)
        return true;
    return false;
}
function isPrivateOrReservedIpv6(address) {
    const normalized = address.toLowerCase();
    return (normalized === "::"
        || normalized === "::1"
        || normalized.startsWith("fc")
        || normalized.startsWith("fd")
        || normalized.startsWith("fe8")
        || normalized.startsWith("fe9")
        || normalized.startsWith("fea")
        || normalized.startsWith("feb"));
}
const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "pwsh", "powershell", "cmd"]);
const ALLOWED_COMMANDS = new Set([
    "cat",
    "cut",
    "echo",
    "file",
    "find",
    "git",
    "grep",
    "head",
    "ls",
    "node",
    "npm",
    "pnpm",
    "pwd",
    "pytest",
    "python",
    "python3",
    "rg",
    "sed",
    "sort",
    "stat",
    "tail",
    "tr",
    "uniq",
    "wc"
]);
const ALLOWED_GIT_SUBCOMMANDS = new Set(["branch", "diff", "log", "ls-files", "rev-parse", "show", "status"]);
const ALLOWED_PACKAGE_MANAGER_SUBCOMMANDS = new Set(["build", "check", "install", "lint", "run", "test", "typecheck"]);
const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback", "metadata.google.internal"]);
//# sourceMappingURL=index.js.map