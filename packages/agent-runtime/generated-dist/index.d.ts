import { getIndex } from "@poke/memory";
import { type ReasoningLevel, type ToolName } from "@poke/shared";
export type AgentRuntime = {
    parentTools: readonly ToolName[];
    childTools: readonly ToolName[];
    parentSystemPrompt: string;
    childSystemPrompt: string;
};
export declare function createAgentRuntime(): AgentRuntime;
export declare const parentTools: {
    get_index: typeof getIndex;
    read_memory: ({ path }: {
        path: string;
    }) => import("@poke/memory").MemoryFile;
    write_memory: (input: {
        path: string;
        title?: string;
        content: string;
    }) => {
        path: string;
        created: boolean;
        updatedIndex: boolean;
    };
    delete_memory: ({ path }: {
        path: string;
    }) => {
        path: string;
        deleted: boolean;
        updatedIndex: boolean;
    };
    ask_poke: (input: {
        task: string;
        reasoning: ReasoningLevel;
        signal?: AbortSignal;
    }) => Promise<{
        output: string;
        artifacts: never[];
    }>;
    send_message: (input: {
        content: string;
        media_path?: string;
    }) => Promise<{
        deliveredTo: "web";
        messageId: string;
        content: string;
    }>;
};
export declare const childTools: {
    read: ({ path: inputPath }: {
        path: string;
    }) => {
        path: string;
        content: string;
    };
    write: ({ path: inputPath, content }: {
        path: string;
        content: string;
    }) => {
        path: string;
        bytes: number;
    };
    edit: ({ path: inputPath, instructions }: {
        path: string;
        instructions: string;
    }) => {
        path: string;
        message: string;
    };
    bash: ({ command, cwd, timeoutSeconds }: {
        command: string;
        cwd?: string;
        timeoutSeconds?: number;
    }) => Promise<{
        stdout: string;
        stderr: string;
    }>;
    web_search: ({ query, numResults }: {
        query: string;
        numResults?: number;
    }) => Promise<any>;
    web_fetch: ({ url }: {
        url: string;
    }) => Promise<{
        url: string;
        content: string;
    }>;
    deep_research: ({ prompt }: {
        prompt: string;
    }) => Promise<{
        prompt: string;
        report: string;
    }>;
    generate_image: ({ prompt, outputPath }: {
        prompt: string;
        outputPath?: string;
    }) => Promise<{
        path: string;
    }>;
    edit_image: ({ prompt, imagePaths, outputPath }: {
        prompt: string;
        imagePaths: string[];
        outputPath?: string;
    }) => Promise<{
        path: string;
    }>;
    transcribe_audio: ({ url, keepFile }: {
        url: string;
        keepFile?: boolean;
    }) => Promise<{
        transcript: string;
        mediaPath?: string;
    }>;
    use_github: () => {
        connector: import("@poke/shared").ConnectorName;
        toolName: string;
        tools: Array<{
            name: string;
            description: string;
        }>;
        instructions: string;
    };
    use_notion: () => {
        connector: import("@poke/shared").ConnectorName;
        toolName: string;
        tools: Array<{
            name: string;
            description: string;
        }>;
        instructions: string;
    };
    use_posthog: () => {
        connector: import("@poke/shared").ConnectorName;
        toolName: string;
        tools: Array<{
            name: string;
            description: string;
        }>;
        instructions: string;
    };
    use_agentmail: () => {
        connector: import("@poke/shared").ConnectorName;
        toolName: string;
        tools: Array<{
            name: string;
            description: string;
        }>;
        instructions: string;
    };
};
