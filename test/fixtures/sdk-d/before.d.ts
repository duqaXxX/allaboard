// Synthetic, in the shape of the declarations of the Agent SDK's `sdk.d.ts`.
export declare class AbortError extends Error {
}

export declare function tagSession(_sessionId: string, _tag: string | null): Promise<void>;

export declare const EXIT_REASONS: readonly ['clear', 'resume'];

export declare type Options = {
    /**
     * Additional directories Claude can access.
     */
    additionalDirectories?: string[];
    model?: string;
    permissionMode?: 'default' | 'plan';
};

export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    /**
     * Interrupt the current query.
     */
    interrupt(): Promise<void>;
    setModel(model?: string): Promise<void>;
    stopTask(taskId: string): Promise<void>;
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

export declare type SDKToolProgressMessage = {
    type: 'tool_progress';
    tool_use_id: string;
};

export declare type SDKMessage = SDKAssistantMessage | SDKTaskStartedMessage | SDKToolProgressMessage;
