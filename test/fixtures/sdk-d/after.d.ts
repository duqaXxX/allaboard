// Synthetic, in the shape of the declarations of the Agent SDK's `sdk.d.ts`.
export declare class AbortError extends Error {
}

export declare function tagSession(_sessionId: string, _tag: string | null): Promise<void>;

export declare function renameSession(_sessionId: string, _title: string): Promise<void>;

export declare type Options = {
    additionalDirectories?: string[];
    model?: string;
    /**
     * Where the session keeps its notes.
     */
    notesDirectory?: string;
};

export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    interrupt(): Promise<void>;
    setModel(model?: string): Promise<void>;
    /**
     * Rewind the files to an earlier message.
     */
    rewindFiles(userMessageId: string): Promise<void>;
}

export declare type SDKAssistantMessage = {
    type: 'assistant';
    uuid: string;
};

export declare type SDKTaskStartedMessage = {
    type: 'system';
    subtype: 'task_started';
    task_id: string;
};

export declare type SDKFooMessage = {
    type: 'system';
    subtype: 'foo_happened';
};

export declare type SDKMessage = SDKAssistantMessage | SDKTaskStartedMessage | SDKFooMessage;
