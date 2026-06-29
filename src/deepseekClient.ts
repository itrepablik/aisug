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
 */
export class DeepSeekClient {
    private readonly apiHost = 'api.deepseek.com';
    private readonly apiPath = '/beta/completions';
    private readonly userAgent = 'vscode-deepseek-inline-completion/0.1.0';

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
            const message = err instanceof Error ? err.message : String(err);
            this.logError(`DeepSeek API request failed: ${message}`);
            return null;
        }
    }

    /**
     * Perform an HTTPS POST request using Node's built-in https module.
     * Supports cancellation via AbortSignal.
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
                            this.logError(
                                `DeepSeek API error ${res.statusCode}: ${responseText.slice(0, 500)}`
                            );
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

    private logError(message: string): void {
        console.error(`[DeepSeek Inline Completion] ${message}`);
    }
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
