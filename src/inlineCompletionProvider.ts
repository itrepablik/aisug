import * as vscode from 'vscode';
import { DeepSeekClient } from './deepseekClient';

/**
 * InlineCompletionItemProvider that uses DeepSeek to generate
 * ghost-text code completions as the user types.
 */
export class DeepSeekInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private readonly client = new DeepSeekClient();

    /** Debounce timer to avoid flooding the API with rapid keystrokes */
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;

    /** AbortController for cancelling in-flight requests */
    private abortController: AbortController | undefined;

    /**
     * Called by VS Code when inline completions should be provided.
     */
    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
        const config = vscode.workspace.getConfiguration('deepseek');

        // Check if completions are globally enabled
        if (!config.get<boolean>('enabled', true)) {
            return [];
        }

        // Check if API key is loaded from SecretStorage
        if (!DeepSeekClient.hasApiKey()) {
            return [];
        }

        // Check language filter
        const enabledLanguages = config.get<string[]>('enabledLanguages', []);
        if (enabledLanguages.length > 0 && !enabledLanguages.includes(document.languageId)) {
            return [];
        }

        // Only trigger on manual invocation or automatic (typing) —
        // skip on explicit "trigger" from other sources if we are debouncing
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
            return this.debouncedComplete(document, position, token);
        }

        // For explicit trigger (e.g., user invokes), go immediately
        return this.getCompletions(document, position, token);
    }

    /**
     * Debounced version: waits for typing to pause before requesting.
     */
    private debouncedComplete(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[]> {
        const config = vscode.workspace.getConfiguration('deepseek');
        const debounceMs = config.get<number>('debounceMs', 300);

        return new Promise((resolve) => {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }

            this.debounceTimer = setTimeout(async () => {
                // Check cancellation again after debounce
                if (token.isCancellationRequested) {
                    resolve([]);
                    return;
                }
                const items = await this.getCompletions(document, position, token);
                resolve(items);
            }, debounceMs);

            // If cancellation is requested during debounce, resolve empty
            token.onCancellationRequested(() => {
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                    this.debounceTimer = undefined;
                }
                resolve([]);
            });
        });
    }

    /**
     * Core completion logic: extract context, call DeepSeek, build InlineCompletionItems.
     */
    private async getCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[]> {
        // Cancel any previous in-flight request
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        // Wire VS Code cancellation to our AbortController
        const onCancel = token.onCancellationRequested(() => {
            this.abortController?.abort();
        });

        try {
            const config = vscode.workspace.getConfiguration('deepseek');
            const contextLines = config.get<number>('contextLines', 50);

            // Extract prefix (code before cursor) and suffix (code after cursor)
            const prefix = this.getPrefix(document, position, contextLines);
            const suffix = this.getSuffix(document, position, contextLines);

            // Don't request if there's nothing meaningful
            if (prefix.trim().length === 0) {
                return [];
            }

            // Combine VS Code token + our AbortController signal
            const completion = await this.client.complete(
                prefix,
                suffix,
                document.languageId,
                this.abortController.signal
            );

            if (!completion || token.isCancellationRequested) {
                return [];
            }

            // Compute the range that the completion would replace
            const range = new vscode.Range(position, position);

            const item = new vscode.InlineCompletionItem(completion, range);
            item.command = {
                command: 'editor.action.inlineSuggest.commit',
                title: 'Accept',
            };

            return [item];
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[DeepSeek Inline Completion] Error: ${message}`);
            return [];
        } finally {
            onCancel.dispose();
        }
    }

    /**
     * Get the code before the cursor (prefix), limited to contextLines.
     */
    private getPrefix(
        document: vscode.TextDocument,
        position: vscode.Position,
        contextLines: number
    ): string {
        const startLine = Math.max(0, position.line - contextLines);
        const start = new vscode.Position(startLine, 0);
        const range = new vscode.Range(start, position);
        return document.getText(range);
    }

    /**
     * Get the code after the cursor (suffix), limited to contextLines.
     */
    private getSuffix(
        document: vscode.TextDocument,
        position: vscode.Position,
        contextLines: number
    ): string {
        const endLine = Math.min(document.lineCount - 1, position.line + contextLines);
        const end = new vscode.Position(endLine, document.lineAt(endLine).text.length);
        const range = new vscode.Range(position, end);
        return document.getText(range);
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }
    }
}
