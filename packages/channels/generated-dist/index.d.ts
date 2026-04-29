import { type ActiveSession, type Channel, type ChatMessage } from "@poke/shared";
export type IncomingMessageInput = {
    channel: Exclude<Channel, "system">;
    content: string;
    mediaPath?: string;
    from?: string;
};
export type MessageResult = {
    session: ActiveSession;
    responseMessage: ChatMessage | null;
};
export declare function getActiveSession(): ActiveSession;
export declare function newSession(): ActiveSession;
export declare function receiveMessage(input: IncomingMessageInput): Promise<MessageResult>;
export declare function handleSlashCommand(command: string, channel: Channel): Promise<ActiveSession>;
export declare function writeSession(session: ActiveSession): void;
export declare function getWhatsAppStatus(): {
    enabled: boolean;
    adapter: "baileys";
    allowedNumber: string | null;
    connected: boolean;
    instructions: string;
};
