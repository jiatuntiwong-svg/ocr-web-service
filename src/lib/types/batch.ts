// Shared batch types — hoisted out of OCRWorkspace so the parent layout
// (which owns batch state across route changes) can reference them.

export type BatchStatus = "queued" | "processing" | "done" | "error" | "skipped";

export interface BatchItem {
    id: string;
    file: File;
    status: BatchStatus;
    data?: Record<string, any> | null;
    error?: string;
    docId?: string | null;
}
