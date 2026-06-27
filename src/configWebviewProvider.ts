import * as vscode from 'vscode';
import { DeepSeekClient } from './deepseekClient';

/**
 * WebviewViewProvider that renders a modern settings form in the
 * Activity Bar sidebar with real HTML inputs — textboxes, dropdowns,
 * password fields, and toggle switches.
 */
export class ConfigWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private readonly _secretStorage: vscode.SecretStorage;

    constructor(secretStorage: vscode.SecretStorage) {
        this._secretStorage = secretStorage;
    }

    /** Called by VS Code when the sidebar view becomes visible. */
    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
        };

        webviewView.webview.html = this.buildHtml();
        this.updateWebviewContent();

        // Handle messages from the webview (user changed a setting)
        webviewView.webview.onDidReceiveMessage((msg) => {
            this.handleMessage(msg);
        });

        // Keep webview in sync when it becomes visible again
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.updateWebviewContent();
            }
        });
    }

    /** Push current settings into the webview. Call on config changes. */
    refresh(): void {
        this.updateWebviewContent();
    }

    // ---- Message handlers ----

    private async handleMessage(msg: ConfigMessage): Promise<void> {
        const config = vscode.workspace.getConfiguration('deepseek');

        switch (msg.type) {
            case 'setEnabled':
                await config.update('enabled', msg.value, vscode.ConfigurationTarget.Global);
                break;

            case 'setApiKey': {
                const key = String(msg.value);
                if (key.trim().length > 0) {
                    await this._secretStorage.store('deepseek.apiKey', key.trim());
                    DeepSeekClient.setApiKey(key.trim());
                } else {
                    await this._secretStorage.delete('deepseek.apiKey');
                    DeepSeekClient.setApiKey(undefined);
                }
                break;
            }

            case 'setModel':
                await config.update('model', msg.value, vscode.ConfigurationTarget.Global);
                break;

            case 'setMaxTokens':
                await config.update('maxTokens', Number(msg.value), vscode.ConfigurationTarget.Global);
                break;

            case 'setTemperature':
                await config.update('temperature', Number(msg.value), vscode.ConfigurationTarget.Global);
                break;

            case 'setDebounce':
                await config.update('debounceMs', Number(msg.value), vscode.ConfigurationTarget.Global);
                break;

            case 'setContextLines':
                await config.update('contextLines', Number(msg.value), vscode.ConfigurationTarget.Global);
                break;

            case 'setLanguages': {
                const langs = String(msg.value)
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                await config.update('enabledLanguages', langs, vscode.ConfigurationTarget.Global);
                break;
            }

            case 'openFullSettings':
                vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    '@ext:INT8Code.deepseek-inline-completion'
                );
                break;
        }
    }

    // ---- WebView content ----

    private updateWebviewContent(): void {
        if (!this._view) return;

        const config = vscode.workspace.getConfiguration('deepseek');
        const hasKey = DeepSeekClient.hasApiKey();
        const enabled = config.get<boolean>('enabled', true);
        const model = config.get<string>('model', 'deepseek-v4-flash');
        const maxTokens = config.get<number>('maxTokens', 256);
        const temperature = config.get<number>('temperature', 0.2);
        const debounceMs = config.get<number>('debounceMs', 300);
        const contextLines = config.get<number>('contextLines', 50);
        const langs = config.get<string[]>('enabledLanguages', []).join(', ');

        this._view.webview.postMessage({
            type: 'updateState',
            enabled,
            hasKey,
            model,
            maxTokens,
            temperature,
            debounceMs,
            contextLines,
            langs,
        });
    }

    private buildHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    :root {
        --bg: var(--vscode-sideBar-background, #1e1e2e);
        --fg: var(--vscode-sideBar-foreground, #cdd6f4);
        --input-bg: var(--vscode-input-background, #313244);
        --input-fg: var(--vscode-input-foreground, #cdd6f4);
        --input-border: var(--vscode-input-border, #45475a);
        --input-focus: var(--vscode-focusBorder, #89b4fa);
        --btn-bg: var(--vscode-button-background, #2563eb);
        --btn-fg: var(--vscode-button-foreground, #ffffff);
        --btn-hover: var(--vscode-button-hoverBackground, #3b82f6);
        --warn: #f59e0b;
        --good: #22c55e;
        --muted: var(--vscode-descriptionForeground, #6c7086);
        --border-subtle: var(--vscode-sideBar-border, #313244);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family, -apple-system, sans-serif);
        font-size: 13px;
        color: var(--fg);
        background: var(--bg);
        padding: 10px 0;
        user-select: none;
        line-height: 1.4;
    }

    .section-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--muted);
        padding: 10px 12px 6px;
    }

    .field {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .field:last-child { border-bottom: none; }

    .field label {
        flex: 0 0 auto;
        min-width: 85px;
        font-weight: 500;
        white-space: nowrap;
        color: var(--fg);
        font-size: 13px;
    }

    /* Toggle switch */
    .toggle {
        position: relative;
        width: 36px;
        height: 20px;
        flex-shrink: 0;
    }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle .slider {
        position: absolute;
        cursor: pointer;
        inset: 0;
        background: var(--input-border);
        border-radius: 20px;
        transition: background 0.15s;
    }
    .toggle .slider::before {
        content: '';
        position: absolute;
        height: 16px;
        width: 16px;
        left: 2px;
        bottom: 2px;
        background: white;
        border-radius: 50%;
        transition: transform 0.15s;
    }
    .toggle input:checked + .slider { background: var(--good); }
    .toggle input:checked + .slider::before { transform: translateX(16px); }

    /* Inputs */
    input[type="text"],
    input[type="number"],
    input[type="password"],
    select {
        flex: 1;
        background: var(--input-bg);
        color: var(--input-fg);
        border: 1px solid var(--input-border);
        border-radius: 4px;
        padding: 5px 8px;
        font-size: 13px;
        font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace));
        outline: none;
        min-width: 0;
        line-height: 1.3;
    }
    input:focus, select:focus {
        border-color: var(--input-focus);
    }
    select {
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236c7086'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 8px center;
        padding-right: 24px;
    }

    input[type="number"] { width: 70px; flex: 0 0 70px; }
    .field-row { display: flex; gap: 6px; align-items: center; flex: 1; }
    .field-row .unit { color: var(--muted); font-size: 12px; flex-shrink: 0; }

    .btn {
        display: block;
        width: calc(100% - 24px);
        margin: 12px;
        padding: 8px;
        background: var(--btn-bg);
        color: var(--btn-fg);
        border: none;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        text-align: center;
    }
    .btn:hover { background: var(--btn-hover); }

    .status-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 6px;
        flex-shrink: 0;
    }
    .status-dot.on { background: var(--good); }
    .status-dot.off { background: var(--muted); }
    .status-dot.warn { background: var(--warn); }

    .info-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 12px;
        color: var(--muted);
    }
</style>
</head>
<body>

<div class="section-title">Status</div>
<div class="info-row">
    <span class="status-dot" id="statusDot"></span>
    <span id="statusText"></span>
</div>

<div class="field">
    <label>Enabled</label>
    <label class="toggle">
        <input type="checkbox" id="enabledToggle" onchange="onEnabledChange(this.checked)">
        <span class="slider"></span>
    </label>
</div>

<div class="field">
    <label>API Key</label>
    <input type="password" id="apiKeyInput" placeholder="sk-..." onblur="onApiKeyChange(this.value)">
</div>

<div class="field">
    <label>Model</label>
    <select id="modelSelect" onchange="onModelChange(this.value)">
        <option value="deepseek-v4-flash">deepseek-v4-flash (fast)</option>
        <option value="deepseek-v4-pro">deepseek-v4-pro (quality)</option>
    </select>
</div>

<div class="field">
    <label>Max Tokens</label>
    <div class="field-row">
        <input type="number" id="maxTokensInput" min="16" max="4096" onchange="onNumberChange('setMaxTokens', this.value, 16, 4096)">
        <span class="unit">tokens</span>
    </div>
</div>

<div class="field">
    <label>Temperature</label>
    <select id="tempSelect" onchange="onModelChange2('setTemperature', this.value)">
        <option value="0">0.0 — deterministic</option>
        <option value="0.1">0.1</option>
        <option value="0.2">0.2</option>
        <option value="0.3">0.3</option>
        <option value="0.5">0.5</option>
        <option value="0.7">0.7</option>
        <option value="1.0">1.0</option>
        <option value="1.5">1.5</option>
        <option value="2.0">2.0 — creative</option>
    </select>
</div>

<div class="section-title">Behavior</div>

<div class="field">
    <label>Debounce</label>
    <div class="field-row">
        <input type="number" id="debounceInput" min="100" max="2000" step="50" onchange="onNumberChange('setDebounce', this.value, 100, 2000)">
        <span class="unit">ms</span>
    </div>
</div>

<div class="field">
    <label>Context</label>
    <div class="field-row">
        <input type="number" id="contextInput" min="10" max="200" onchange="onNumberChange('setContextLines', this.value, 10, 200)">
        <span class="unit">lines</span>
    </div>
</div>

<div class="field">
    <label>Languages</label>
    <input type="text" id="langsInput" placeholder="All (empty = all)" onblur="onLangsChange(this.value)">
</div>

<button class="btn" onclick="post({type:'openFullSettings'})">Open Full Settings (settings.json)</button>

<script>
const vscode = acquireVsCodeApi();

function post(msg) { vscode.postMessage(msg); }

// ---- State update from extension ----
window.addEventListener('message', (e) => {
    const d = e.data;
    if (d.type !== 'updateState') return;

    // Status
    const dot = document.getElementById('statusDot');
    const txt = document.getElementById('statusText');
    dot.className = 'status-dot ' + (d.enabled ? (d.hasKey ? 'on' : 'warn') : 'off');
    txt.textContent = d.enabled
        ? (d.hasKey ? 'Active — ' + d.model : '⚠ No API key configured')
        : 'Completions disabled';

    // Enabled toggle
    document.getElementById('enabledToggle').checked = d.enabled;

    // API key (don't overwrite if user is currently editing)
    const keyInput = document.getElementById('apiKeyInput');
    if (document.activeElement !== keyInput) {
        keyInput.value = d.hasKey ? '●●●●●●●●●●●●●●●●' : '';
    }

    // Model
    document.getElementById('modelSelect').value = d.model;

    // Max tokens
    const mt = document.getElementById('maxTokensInput');
    if (document.activeElement !== mt) mt.value = d.maxTokens;

    // Temperature
    document.getElementById('tempSelect').value = String(d.temperature);

    // Debounce
    const db = document.getElementById('debounceInput');
    if (document.activeElement !== db) db.value = d.debounceMs;

    // Context lines
    const cl = document.getElementById('contextInput');
    if (document.activeElement !== cl) cl.value = d.contextLines;

    // Languages
    const li = document.getElementById('langsInput');
    if (document.activeElement !== li) li.value = d.langs;
});

// ---- Handlers ----
function onEnabledChange(val) { post({type:'setEnabled', value:val}); }

let _apiKeyDirty = false;

function onApiKeyChange(val) {
    // Only save if user actually typed something (not just dots, not empty-after-dots)
    if (val === '●●●●●●●●●●●●●●●●' || val === '') {
        // User left the field without changing — restore dots
        if (_apiKeyDirty) {
            document.getElementById('apiKeyInput').value = '●●●●●●●●●●●●●●●●';
            _apiKeyDirty = false;
        }
        return;
    }
    // User typed a real value
    _apiKeyDirty = false;
    post({type:'setApiKey', value:val});
}

function onModelChange(val) { post({type:'setModel', value:val}); }

function onModelChange2(type, val) { post({type, value:val}); }

function onNumberChange(type, val, min, max) {
    const n = parseInt(val, 10);
    if (isNaN(n)) return;
    const clamped = Math.max(min, Math.min(max, n));
    post({type, value:clamped});
    // Clamp the input visually
    const el = document.activeElement;
    if (el && el.tagName === 'INPUT') el.value = clamped;
}

function onLangsChange(val) { post({type:'setLanguages', value:val}); }

// Focus: select all dots so user can type over them (don't clear — that triggers delete)
document.getElementById('apiKeyInput').addEventListener('focus', function() {
    if (this.value.startsWith('●')) {
        this.select();
        _apiKeyDirty = true;
    }
});
</script>
</body>
</html>`;
    }
}

// ---- Message types ----

interface ConfigMessage {
    type: string;
    value: string | boolean | number;
}
