import * as vscode from 'vscode';
import { DeepSeekInlineCompletionProvider } from './inlineCompletionProvider';
import { DeepSeekClient } from './deepseekClient';
import { ConfigWebviewProvider } from './configWebviewProvider';

/** SecretStorage key for the DeepSeek API key. */
const SECRET_KEY = 'deepseek.apiKey';
const CONFIG_NS = 'deepseek';

let provider: DeepSeekInlineCompletionProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let configWebview: ConfigWebviewProvider | undefined;

/**
 * Called when the extension is activated.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // ---- Load API key from SecretStorage ----
    await loadApiKey(context);

    provider = new DeepSeekInlineCompletionProvider();

    // Register the inline completion provider for all file types.
    const selector: vscode.DocumentSelector = { scheme: 'file' };
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(selector, provider)
    );

    // ---- Activity Bar: WebView Settings Panel ----
    configWebview = new ConfigWebviewProvider(context.secrets);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('deepseek.configTree', configWebview)
    );

    // ---- Status Bar Item ----
    statusBarItem = createStatusBarItem();
    context.subscriptions.push(statusBarItem);

    // ---- Register Commands ----
    registerCommands(context);

    // ---- Configuration change listener ----
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CONFIG_NS)) {
                updateStatusBar();
                configWebview?.refresh();

                const config = vscode.workspace.getConfiguration(CONFIG_NS);
                const enabled = config.get<boolean>('enabled', true);

                if (enabled && !DeepSeekClient.hasApiKey()) {
                    vscode.window
                        .showWarningMessage(
                            'DeepSeek inline completions are enabled but no API key is set.',
                            'Set API Key'
                        )
                        .then((selection) => {
                            if (selection === 'Set API Key') {
                                vscode.commands.executeCommand('deepseek.setApiKey');
                            }
                        });
                }
            }
        })
    );

    // Show setup prompt on first activation if no API key
    if (!DeepSeekClient.hasApiKey()) {
        vscode.window
            .showInformationMessage(
                'DeepSeek Inline Completion: Set your API key to get started.',
                'Set API Key',
                'Later'
            )
            .then((selection) => {
                if (selection === 'Set API Key') {
                    vscode.commands.executeCommand('deepseek.setApiKey');
                }
            });
    }

    // Listen for SecretStorage changes (e.g., from another window)
    context.subscriptions.push(
        context.secrets.onDidChange((e) => {
            if (e.key === SECRET_KEY) {
                context.secrets.get(SECRET_KEY).then((key) => {
                    DeepSeekClient.setApiKey(key);
                    updateStatusBar();
                    configWebview?.refresh();
                });
            }
        })
    );

    updateStatusBar();
}

// ---- Command Registration ----

function registerCommands(context: vscode.ExtensionContext): void {
    const config = () => vscode.workspace.getConfiguration(CONFIG_NS);

    // Toggle enabled
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.toggleCompletion', async () => {
            const current = config().get<boolean>('enabled', true);
            await config().update('enabled', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `DeepSeek inline completions: ${!current ? 'Enabled' : 'Disabled'}`
            );
        })
    );

    // Set API key
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.setApiKey', async () => {
            const currentKey = await context.secrets.get(SECRET_KEY);

            const newKey = await vscode.window.showInputBox({
                title: 'DeepSeek API Key',
                prompt: 'Enter your DeepSeek API key (stored securely in VS Code SecretStorage)',
                placeHolder: 'sk-...',
                password: true,
                value: currentKey ?? '',
                ignoreFocusOut: true,
            });

            if (newKey !== undefined) {
                if (newKey.trim().length === 0) {
                    await context.secrets.delete(SECRET_KEY);
                    DeepSeekClient.setApiKey(undefined);
                    vscode.window.showInformationMessage('DeepSeek API key removed.');
                } else {
                    await context.secrets.store(SECRET_KEY, newKey.trim());
                    DeepSeekClient.setApiKey(newKey.trim());
                    vscode.window.showInformationMessage('DeepSeek API key stored securely.');
                }
                updateStatusBar();
                configWebview?.refresh();
            }
        })
    );

    // Open full settings UI
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.openSettings', () => {
            vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:aisug.deepseek-inline-completion'
            );
        })
    );

    // Select model
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.selectModel', async () => {
            const current = config().get<string>('model', 'deepseek-chat');
            const picked = await vscode.window.showQuickPick(
                [
                    { label: 'deepseek-chat', description: 'General-purpose, fast, cost-effective' },
                    { label: 'deepseek-coder', description: 'Code-optimized, higher quality for programming' },
                ],
                { placeHolder: `Current: ${current}` }
            );
            if (picked) {
                await config().update('model', picked.label, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Model set to ${picked.label}.`);
            }
        })
    );

    // Edit max tokens
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.editMaxTokens', async () => {
            await editNumberSetting('maxTokens', 'Max Tokens', 16, 4096);
        })
    );

    // Edit temperature
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.editTemperature', async () => {
            const current = config().get<number>('temperature', 0.2);
            const picked = await vscode.window.showQuickPick(
                ['0', '0.1', '0.2', '0.3', '0.5', '0.7', '1.0', '1.5', '2.0'].map((v) => ({
                    label: v,
                    description: Number(v) === current ? '(current)' : '',
                })),
                { placeHolder: `Temperature (current: ${current})` }
            );
            if (picked) {
                await config().update('temperature', Number(picked.label), vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Temperature set to ${picked.label}.`);
            }
        })
    );

    // Edit debounce
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.editDebounce', async () => {
            await editNumberSetting('debounceMs', 'Debounce (ms)', 100, 2000);
        })
    );

    // Edit context lines
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.editContextLines', async () => {
            await editNumberSetting('contextLines', 'Context Lines', 10, 200);
        })
    );

    // Edit enabled languages
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.editLanguages', async () => {
            const current = config().get<string[]>('enabledLanguages', []);
            const currentStr = current.length === 0 ? '' : current.join(', ');
            const input = await vscode.window.showInputBox({
                title: 'Enabled Languages',
                prompt: 'Comma-separated language IDs (empty = all languages). Example: javascript,typescript,python',
                placeHolder: 'javascript,typescript,python',
                value: currentStr,
                ignoreFocusOut: true,
            });
            if (input !== undefined) {
                const langs = input
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                await config().update('enabledLanguages', langs, vscode.ConfigurationTarget.Global);
                const desc = langs.length === 0 ? 'All languages' : langs.join(', ');
                vscode.window.showInformationMessage(`Enabled languages: ${desc}`);
            }
        })
    );
}

// ---- Helpers ----

/** Reusable number input editor for integer settings. */
async function editNumberSetting(
    key: string,
    label: string,
    min: number,
    max: number
): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_NS);
    const current = config.get<number>(key, min);
    const input = await vscode.window.showInputBox({
        title: label,
        prompt: `Enter a value between ${min} and ${max}`,
        value: String(current),
        validateInput: (val) => {
            const n = Number(val);
            if (isNaN(n) || !Number.isInteger(n)) return 'Must be an integer';
            if (n < min) return `Minimum is ${min}`;
            if (n > max) return `Maximum is ${max}`;
            return null;
        },
        ignoreFocusOut: true,
    });
    if (input !== undefined) {
        await config.update(key, Number(input), vscode.ConfigurationTarget.Global);
    }
}

function createStatusBarItem(): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        99
    );
    item.command = 'deepseek.openSettings';
    item.tooltip = 'DeepSeek Inline Completion — Click to open settings';
    item.show();
    return item;
}

function updateStatusBar(): void {
    if (!statusBarItem) return;

    const config = vscode.workspace.getConfiguration(CONFIG_NS);
    const enabled = config.get<boolean>('enabled', true);
    const hasKey = DeepSeekClient.hasApiKey();
    const model = config.get<string>('model', 'deepseek-chat');
    const modelShort = model === 'deepseek-coder' ? 'Coder' : 'Chat';

    if (!enabled) {
        statusBarItem.text = '$(circle-slash) DeepSeek: Off';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'DeepSeek completions are disabled. Click to open settings.';
    } else if (!hasKey) {
        statusBarItem.text = '$(warning) DeepSeek: No Key';
        statusBarItem.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.warningBackground'
        );
        statusBarItem.tooltip = 'API key not set. Click to open settings, then run "DeepSeek: Set API Key".';
    } else {
        statusBarItem.text = `$(sparkle) DeepSeek: ${modelShort}`;
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = `DeepSeek completions active (${model}). Click to open settings.`;
    }
}

async function loadApiKey(context: vscode.ExtensionContext): Promise<void> {
    const key = await context.secrets.get(SECRET_KEY);
    if (key) {
        DeepSeekClient.setApiKey(key);
    }
}

export function deactivate(): void {
    provider?.dispose();
    provider = undefined;
    statusBarItem?.dispose();
    statusBarItem = undefined;
    configWebview = undefined;
    DeepSeekClient.setApiKey(undefined);
}
