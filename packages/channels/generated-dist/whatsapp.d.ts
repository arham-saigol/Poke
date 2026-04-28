export type WhatsAppRuntime = {
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
};
type PairingMaterial = {
    kind: "pairing_code" | "qr";
    value: string;
    createdAt: string;
    expiresAt: string;
};
export declare function createWhatsAppRuntime(): Promise<WhatsAppRuntime>;
export declare function getWhatsAppPairingMaterial(): PairingMaterial[];
export declare function onWhatsAppPairingMaterial(listener: (entry: PairingMaterial) => void): () => void;
export {};
