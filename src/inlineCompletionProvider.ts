import * as vscode from 'vscode';
import { DeepSeekClient, DeepSeekApiError } from './deepseekClient';

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

    /** Timer for showing error notifications (prevents spam on rapid typing). */
    private errorNotificationTimer: ReturnType<typeof setTimeout> | undefined;

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
     *
     * After every API call, checks for a consumed error and surfaces
     * user-visible warnings for authentication / billing problems.
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

            // Check for API errors that should be surfaced to the user
            this.showPendingApiError();

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
     * Consume the most recent API error (if any) and show an appropriate
     * VS Code warning notification with action buttons.
     *
     * Uses a small debounce so that rapid successive calls (e.g., while
     * typing quickly) produce only one notification.
     */
    private showPendingApiError(): void {
        const apiError = DeepSeekClient.consumeError();
        if (!apiError) {
            return;
        }

        // Small notification debounce: if a notification timer is already
        // pending, let it fire; the next error will be picked up later.
        if (this.errorNotificationTimer) {
            return;
        }

        // Defer the notification slightly so rapid typing doesn't stack
        // multiple VS Code message boxes simultaneously.
        this.errorNotificationTimer = setTimeout(() => {
            this.errorNotificationTimer = undefined;
            this.showErrorNotification(apiError);
        }, 200);
    }

    /**
     * Display the appropriate VS Code warning based on error category.
     */
    private showErrorNotification(apiError: DeepSeekApiError): void {
        switch (apiError.category) {
            case DeepSeekClient.ErrorCategory.Authentication:
                this.showAuthError(apiError);
                break;
            case DeepSeekClient.ErrorCategory.Payment:
                this.showPaymentError(apiError);
                break;
            case DeepSeekClient.ErrorCategory.RateLimit:
                // Rate-limited — not actionable; just log to console
                break;
            case DeepSeekClient.ErrorCategory.Network:
                // Network errors are transient; logged already
                break;
            default:
                // Server errors / invalid requests — logged already
                break;
        }
    }

    /**
     * Show an authentication error warning with a "Set API Key" action.
     */
    private showAuthError(apiError: DeepSeekApiError): void {
        const detail = apiError.message.length > 120
            ? apiError.message.slice(0, 120) + '…'
            : apiError.message;

        vscode.window
            .showWarningMessage(
                `DeepSeek: Authentication failed — ${detail}`,
                'Set API Key',
                'Dismiss'
            )
            .then((selection) => {
                if (selection === 'Set API Key') {
                    vscode.commands.executeCommand('deepseek.setApiKey');
                }
            });
    }

    /**
     * Show a payment/balance error warning.
     */
    private showPaymentError(apiError: DeepSeekApiError): void {
        vscode.window
            .showWarningMessage(
                `DeepSeek: ${apiError.message}`,
                'Open Platform',
                'Dismiss'
            )
            .then((selection) => {
                if (selection === 'Open Platform') {
                    vscode.env.openExternal(
                        vscode.Uri.parse('https://platform.deepseek.com/top_up')
                    );
                }
            });
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
        if (this.errorNotificationTimer) {
            clearTimeout(this.errorNotificationTimer);
            this.errorNotificationTimer = undefined;
        }
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }
    }
}
