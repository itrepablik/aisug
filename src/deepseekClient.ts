import * as vscode from 'vscode';
import * as https from 'node:https';
import { IncomingMessage } from 'node:http';

/**
 * DeepSeek API client for code completions.
 * Uses the OpenAI-compatible chat completions endpoint with
 * Fill-in-the-Middle (FIM) prompting for inline code suggestions.
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
    private readonly apiPath = '/v1/chat/completions';
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
     * Request a code completion from the DeepSeek API.
     *
     * @param prefix - Code before the cursor
     * @param suffix - Code after the cursor
     * @param language - The language ID of the current document
     * @param signal - AbortSignal for cancellation
     * @returns The completion text, or null if no completion is available
     */
    async complete(
        prefix: string,
        suffix: string,
        language: string,
        signal: AbortSignal
    ): Promise<string | null> {
        const apiKey = DeepSeekClient._apiKey;
        if (!apiKey) {
            return null;
        }

        const config = vscode.workspace.getConfiguration('deepseek');
        const model = config.get<string>('model', 'deepseek-chat');
        const maxTokens = config.get<number>('maxTokens', 256);
        const temperature = config.get<number>('temperature', 0.2);

        const prompt = this.buildFimPrompt(prefix, suffix, language);

        const body = JSON.stringify({
            model,
            messages: [
                {
                    role: 'system',
                    content: this.buildSystemPrompt(language),
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            max_tokens: maxTokens,
            temperature,
            top_p: 0.95,
            stream: false,
        });

        try {
            const responseText = await this.httpsRequest(body, apiKey, signal);
            const data = JSON.parse(responseText) as DeepSeekChatResponse;

            const choice = data.choices?.[0];
            if (!choice?.message?.content) {
                return null;
            }

            const raw = choice.message.content;
            return this.extractCompletion(raw, prefix);
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                // Request was cancelled, this is expected
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
     * Build the system prompt instructing the model how to behave
     * as an inline code completion assistant.
     */
    private buildSystemPrompt(language: string): string {
        return [
            'You are an expert inline code completion assistant.',
            `You complete code in the ${language} programming language.`,
            '',
            'RULES:',
            '1. Return ONLY the code that should appear at the cursor position.',
            '2. Do NOT repeat the prefix (code before cursor) or suffix (code after cursor).',
            '3. Do NOT include any explanations, markdown fences, or commentary.',
            '4. Complete the current statement/expression logically.',
            '5. If the cursor is mid-identifier, complete that identifier naturally.',
            '6. If there is nothing meaningful to complete, return an empty response.',
            '7. Maintain the same indentation style as the surrounding code.',
            '8. Multi-line completions are acceptable when appropriate (e.g., closing braces).',
        ].join('\n');
    }

    /**
     * Build a Fill-in-the-Middle style prompt for the chat model.
     * Since DeepSeek chat models don't have native FIM, we describe
     * prefix/suffix clearly in the user message.
     */
    private buildFimPrompt(prefix: string, suffix: string, language: string): string {
        const truncatedPrefix = this.truncateCode(prefix, 2000);
        const truncatedSuffix = this.truncateCode(suffix, 1000);

        let prompt = `Complete the code at the <CURSOR> position in the following ${language} file.\n\n`;

        if (truncatedPrefix) {
            prompt += `<PREFIX>\n${truncatedPrefix}\n</PREFIX>\n\n`;
        } else {
            prompt += `<PREFIX>\n[beginning of file]\n</PREFIX>\n\n`;
        }

        prompt += '<CURSOR>\n\n';

        if (truncatedSuffix) {
            prompt += `<SUFFIX>\n${truncatedSuffix}\n</SUFFIX>`;
        } else {
            prompt += '<SUFFIX>\n[end of file]\n</SUFFIX>';
        }

        prompt += '\n\nReturn ONLY the code that replaces <CURSOR>. Do not wrap in backticks.';

        return prompt;
    }

    /**
     * Extract the actual completion from the model response,
     * stripping any markdown fences or stray formatting.
     */
    private extractCompletion(raw: string, prefix: string): string | null {
        let text = raw.trim();

        // Strip markdown code fences if present
        const fenceMatch = text.match(/^```[\w]*\n([\s\S]*?)\n```$/);
        if (fenceMatch) {
            text = fenceMatch[1].trim();
        }

        // If the model returned the prefix again, strip it
        if (prefix && text.startsWith(prefix)) {
            text = text.slice(prefix.length);
        }

        // If nothing meaningful remains, return null
        if (!text || text.length === 0) {
            return null;
        }

        return text;
    }

    /**
     * Truncate code to a maximum character length, keeping the most
     * relevant portion (end for prefix, beginning for suffix).
     */
    private truncateCode(code: string, maxChars: number): string {
        if (code.length <= maxChars) {
            return code;
        }
        // For prefix, keep the tail (closest to cursor)
        return '…\n' + code.slice(code.length - maxChars + 2);
    }

    private logError(message: string): void {
        console.error(`[DeepSeek Inline Completion] ${message}`);
    }
}

// ---- API Response Types ----

interface DeepSeekChatResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices?: DeepSeekChoice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

interface DeepSeekChoice {
    index: number;
    message?: {
        role: string;
        content: string;
    };
    finish_reason: string;
}
