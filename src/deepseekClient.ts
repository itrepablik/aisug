import * as vscode from 'vscode';
import * as https from 'node:https';
import { IncomingMessage } from 'node:http';

/**
 * DeepSeek API client for code completions.
 *
 * Uses the native **Fill-in-the-Middle (FIM) completion API**
 * at `POST /beta/completions` — purpose-built for inline code
 * suggestions. See: https://api-docs.deepseek.com/guides/fim_completion
 *
 * The endpoint accepts `prompt` (code before cursor) and `suffix`
 * (code after cursor) directly, without requiring chat messages
 * or manual `<PREFIX>` / `<SUFFIX>` markup.
 *
 * Uses Node's built-in `https` module (not `fetch`) for maximum
 * compatibility with all VS Code extension host Node runtimes.
 *
 * ## API Key Security
 *
 * The API key is stored in VS Code's **SecretStorage** (not in
 * user settings). Use the static `setApiKey()` / `getApiKey()`
 * methods to manage it. The key is held in memory only for the
 * lifetime of the extension host process.
 *
 * ## Error Handling
 *
 * API errors are categorized per the official DeepSeek error codes:
 * https://api-docs.deepseek.com/quick_start/error_codes
 *
 * Authentication (401) and billing (402) errors are surfaced as
 * VS Code warnings with action buttons. Transient errors (429, 5xx)
 * are logged to console only to avoid spamming the user.
 */
export class DeepSeekClient {
    private readonly apiHost = 'api.deepseek.com';
    private readonly apiPath = '/beta/completions';
    private readonly userAgent = 'vscode-deepseek-inline-completion/0.1.2';

    // ---- Static API key (set by extension.ts from SecretStorage) ----

    private static _apiKey: string | undefined;

    /** Store the API key in memory. Called by the extension on activation. */
    static setApiKey(key: string | undefined): void {
        DeepSeekClient._apiKey = key;
    }

    /** Retrieve the current API key, or undefined if not set. */
    static getApiKey(): string | undefined {
        return DeepSeekClient._apiKey;
    }

    /** Returns true if an API key has been loaded from SecretStorage. */
    static hasApiKey(): boolean {
        return !!DeepSeekClient._apiKey;
    }

    // ---- Static error state (debounced to avoid spamming) ----

    /** Categories matching DeepSeek's official error classification. */
    static readonly ErrorCategory = {
        Authentication: 'authentication' as const,
        Payment: 'payment' as const,
        RateLimit: 'rate_limit' as const,
        InvalidRequest: 'invalid_request' as const,
        ServerError: 'server_error' as const,
        Network: 'network' as const,
    } as const;

    /** Last categorized API error, if any. Cleared after consumption. */
    private static _lastError: DeepSeekApiError | null = null;

    /** Minimum interval (ms) between showing the same category of error. */
    private static _lastErrorShownAt = new Map<string, number>();
    private static readonly ERROR_COOLDOWN_MS = 30_000; // 30 seconds

    /**
     * Consume the last stored API error, returning it exactly once.
     * After this call the error is cleared. Returns null if no error
     * is pending or the cooldown for its category hasn't expired.
     *
     * Callers should use this to show a single VS Code warning per
     * error category per cooldown window.
     */
    static consumeError(): DeepSeekApiError | null {
        const err = DeepSeekClient._lastError;
        if (!err) {
            return null;
        }

        const lastShown = DeepSeekClient._lastErrorShownAt.get(err.category) ?? 0;
        const now = Date.now();
        if (now - lastShown < DeepSeekClient.ERROR_COOLDOWN_MS) {
            return null; // Still in cooldown — don't spam
        }

        DeepSeekClient._lastErrorShownAt.set(err.category, now);
        DeepSeekClient._lastError = null;
        return err;
    }

    /** Store an API error for later consumption by the UI layer. */
    private static storeError(err: DeepSeekApiError): void {
        DeepSeekClient._lastError = err;
        console.error(
            `[DeepSeek Inline Completion] ${err.category} error (HTTP ${err.statusCode}): ${err.message}` +
            (err.deepseekCode ? ` [code: ${err.deepseekCode}]` : '')
        );
    }

    /** Clear all stored error state (e.g., on API key change). */
    static clearErrors(): void {
        DeepSeekClient._lastError = null;
        DeepSeekClient._lastErrorShownAt.clear();
    }

    // ---- Instance methods ----

    /**
     * Request a code completion from the DeepSeek FIM API.
     *
     * Sends prefix (code before cursor) and suffix (code after cursor)
     * directly to the native FIM endpoint. The model fills the gap.
     *
     * @param prefix - Code before the cursor position
     * @param suffix - Code after the cursor position
     * @param _language - Language ID (unused by FIM endpoint — the model
     *                    infers language from the code context itself)
     * @param signal - AbortSignal for cancellation
     * @returns The completion text, or null if no completion is available
     */
    async complete(
        prefix: string,
        suffix: string,
        _language: string,
        signal: AbortSignal
    ): Promise<string | null> {
        const apiKey = DeepSeekClient._apiKey;
        if (!apiKey) {
            return null;
        }

        const config = vscode.workspace.getConfiguration('deepseek');
        const model = config.get<string>('model', 'deepseek-v4-flash');
        const maxTokens = config.get<number>('maxTokens', 256);
        const temperature = config.get<number>('temperature', 0.2);

        // Truncate prefix/suffix to avoid sending excessive context
        const truncatedPrefix = this.truncateCode(prefix, 4000);
        const truncatedSuffix = this.truncateCode(suffix, 2000);

        const body = JSON.stringify({
            model,
            prompt: truncatedPrefix,
            suffix: truncatedSuffix,
            max_tokens: maxTokens,
            temperature,
            top_p: 0.95,
            stream: false,
        });

        try {
            const responseText = await this.httpsRequest(body, apiKey, signal);
            const data = JSON.parse(responseText) as DeepSeekFimResponse;

            const choice = data.choices?.[0];
            if (!choice?.text) {
                return null;
            }

            // The FIM endpoint returns the completion directly — no markdown
            // fences, no prefix repetition. Just trim whitespace.
            const text = choice.text.trim();
            return text.length > 0 ? text : null;
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                return null;
            }
            // Network-level errors (DNS, TLS, timeout) — store as Network category.
            // API-level errors (4xx/5xx) are already stored by httpsRequest before
            // resolving, so they don't reach this catch block.
            DeepSeekClient.storeError({
                category: DeepSeekClient.ErrorCategory.Network,
                statusCode: 0,
                message: err instanceof Error ? err.message : String(err),
                timestamp: Date.now(),
            });
            return null;
        }
    }

    /**
     * Perform an HTTPS POST request using Node's built-in https module.
     * Supports cancellation via AbortSignal.
     *
     * On non-200 responses, parses the error body per DeepSeek's error
     * schema and stores a categorized DeepSeekApiError for the UI layer.
     */
    private httpsRequest(body: string, apiKey: string, signal: AbortSignal): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const req = https.request(
                {
                    hostname: this.apiHost,
                    path: this.apiPath,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                        'User-Agent': this.userAgent,
                        'Content-Length': Buffer.byteLength(body),
                    },
                    timeout: 15_000, // 15-second socket timeout
                },
                (res: IncomingMessage) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        const responseText = Buffer.concat(chunks).toString('utf-8');

                        if (res.statusCode !== 200) {
                            const apiError = DeepSeekClient.parseErrorResponse(
                                res.statusCode ?? 0,
                                responseText
                            );
                            DeepSeekClient.storeError(apiError);
                            resolve('{}'); // Return empty JSON; caller handles missing choices
                            return;
                        }

                        resolve(responseText);
                    });
                    res.on('error', reject);
                }
            );

            req.on('error', (err: Error) => {
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });

            // Wire AbortSignal for cancellation
            const abortError = (): Error => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                return err;
            };

            if (signal.aborted) {
                req.destroy();
                reject(abortError());
                return;
            }

            const onAbort = () => {
                req.destroy();
                reject(abortError());
            };
            signal.addEventListener('abort', onAbort, { once: true });

            req.write(body);
            req.end();
        });
    }

    /**
     * Parse a DeepSeek API error response body into a categorized error.
     *
     * Error response schema (from official docs):
     * ```json
     * { "error": { "message": "...", "type": "...", "param": null, "code": "..." } }
     * ```
     *
     * See: https://api-docs.deepseek.com/quick_start/error_codes
     */
    private static parseErrorResponse(
        statusCode: number,
        responseText: string
    ): DeepSeekApiError {
        let errorMessage = `HTTP ${statusCode}`;
        let deepseekCode: string | undefined;
        let deepseekType: string | undefined;

        try {
            const body = JSON.parse(responseText) as { error?: DeepSeekErrorBody };
            if (body.error?.message) {
                errorMessage = body.error.message;
            }
            if (body.error?.code) {
                deepseekCode = body.error.code;
            }
            if (body.error?.type) {
                deepseekType = body.error.type;
            }
        } catch {
            // Response body isn't valid JSON — use the raw text (truncated)
            if (responseText.trim().length > 0) {
                errorMessage = responseText.slice(0, 200);
            }
        }

        return {
            category: DeepSeekClient.categorizeError(statusCode, deepseekCode, deepseekType),
            statusCode,
            message: errorMessage,
            deepseekCode,
            timestamp: Date.now(),
        };
    }

    /**
     * Map an HTTP status code and optional DeepSeek error code to a category.
     *
     * Classification follows https://api-docs.deepseek.com/quick_start/error_codes:
     * - 400: invalid_request_error    → InvalidRequest
     * - 401: authentication_error     → Authentication
     * - 402: insufficient_balance     → Payment
     * - 422: invalid_request_error    → InvalidRequest
     * - 429: rate_limit_reached_error → RateLimit
     * - 500: internal_server_error    → ServerError
     * - 503: server_overloaded_error  → ServerError
     */
    private static categorizeError(
        statusCode: number,
        deepseekCode?: string,
        deepseekType?: string
    ): DeepSeekErrorCategory {
        // Use DeepSeek's explicit error code/type when available
        if (deepseekCode === 'invalid_api_key' || deepseekType === 'authentication_error') {
            return DeepSeekClient.ErrorCategory.Authentication;
        }
        if (deepseekCode === 'insufficient_balance' || deepseekType === 'insufficient_balance') {
            return DeepSeekClient.ErrorCategory.Payment;
        }
        if (deepseekCode === 'rate_limit_reached_error' || statusCode === 429) {
            return DeepSeekClient.ErrorCategory.RateLimit;
        }

        // Fallback to HTTP status code classification
        switch (statusCode) {
            case 401:
                return DeepSeekClient.ErrorCategory.Authentication;
            case 402:
                return DeepSeekClient.ErrorCategory.Payment;
            case 429:
                return DeepSeekClient.ErrorCategory.RateLimit;
            case 400:
            case 422:
                return DeepSeekClient.ErrorCategory.InvalidRequest;
            case 500:
            case 502:
            case 503:
            case 504:
                return DeepSeekClient.ErrorCategory.ServerError;
            default:
                return DeepSeekClient.ErrorCategory.ServerError;
        }
    }

    /**
     * Truncate code to a maximum character length, keeping the most
     * relevant portion. For prefix, keeps the tail (closest to cursor).
     * For suffix, the caller passes code that's already closest to cursor.
     */
    private truncateCode(code: string, maxChars: number): string {
        if (code.length <= maxChars) {
            return code;
        }
        return '…\n' + code.slice(code.length - maxChars + 2);
    }
}

// ---- API Error Types ----

/** Union of all error category string literals. */
export type DeepSeekErrorCategory =
    | 'authentication'
    | 'payment'
    | 'rate_limit'
    | 'invalid_request'
    | 'server_error'
    | 'network';

/** Structured information about a DeepSeek API error. */
export interface DeepSeekApiError {
    category: DeepSeekErrorCategory;
    statusCode: number;
    message: string;
    deepseekCode?: string;
    timestamp: number;
}

/** Shape of the `error` object inside a DeepSeek error response. */
interface DeepSeekErrorBody {
    message: string;
    type: string;
    param: string | null;
    code: string;
}

// ---- FIM API Response Types ----
// See: https://api-docs.deepseek.com/guides/fim_completion

interface DeepSeekFimResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices?: DeepSeekFimChoice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

interface DeepSeekFimChoice {
    index: number;
    text: string;
    finish_reason: string;
}
