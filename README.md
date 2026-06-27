# DeepSeek Inline Completion for VS Code

AI-powered inline (ghost-text) code completions using the [DeepSeek API](https://platform.deepseek.com/). As you type, the extension sends surrounding context to DeepSeek's chat models and renders suggestions directly in your editor — just like GitHub Copilot's inline completions.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
  - [From Source (Development)](#from-source-development)
  - [Packaging as `.vsix`](#packaging-as-vsix)
- [Quick Start](#quick-start)
- [Settings Reference](#settings-reference)
- [Commands](#commands)
- [How It Works](#how-it-works)
  - [Request Lifecycle](#request-lifecycle)
  - [Prompt Structure](#prompt-structure)
  - [Response Extraction](#response-extraction)
- [Architecture](#architecture)
  - [File Map](#file-map)
  - [Data Flow](#data-flow)
  - [Class Diagram](#class-diagram)
- [Configuration Recipes](#configuration-recipes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
  - [Project Setup](#project-setup)
  - [Build & Run](#build--run)
  - [Debugging](#debugging)
  - [Adding Features](#adding-features)
- [FAQ](#faq)
- [License](#license)

---

## Features

| Feature | Detail |
|---|---|
| **Ghost-text completions** | Suggestions appear as faded inline text, accepted via `Tab` |
| **Multi-language support** | Works with any language; optionally restrict via `enabledLanguages` |
| **Context-aware prompting** | Sends code before (`<PREFIX>`) and after (`<SUFFIX>`) the cursor |
| **Debounced requests** | Configurable delay prevents flooding the API while typing |
| **Cancellation on keystroke** | In-flight requests are aborted when you keep typing |
| **Configurable model** | Use `deepseek-chat` or `deepseek-coder` |
| **Zero external HTTP dependencies** | Uses Node.js built-in `https` module — no `node-fetch` or `axios` |
| **Secure API key storage** | Keys are stored in VS Code's [SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), never in plaintext settings |

---

## Requirements

| Component | Minimum Version |
|---|---|
| **VS Code** | 1.82.0 (September 2023) |
| **Node.js** | 18.x (bundled with VS Code ≥ 1.82) |
| **DeepSeek API key** | [Get one here](https://platform.deepseek.com/api_keys) |

> **Note:** The extension uses Node's built-in `https` module, so no `fetch` polyfill or extra dependencies are required.

---

## Installation

### From Source (Development)

```bash
# Clone or navigate to the extension directory
cd aisug

# Install dependencies
npm install

# Compile TypeScript
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

### Packaging as `.vsix`

```bash
# Install vsce globally (one-time)
npm install -g @vscode/vsce

# Package the extension
vsce package

# Install the resulting .vsix in VS Code:
#   Ctrl+Shift+P → "Extensions: Install from VSIX..."
```

---

## Quick Start

1. **Set your API key** — Run `DeepSeek: Set API Key` from the Command Palette (`Ctrl+Shift+P`). Enter your key from [platform.deepseek.com](https://platform.deepseek.com/api_keys). The key is stored **securely** in VS Code's [SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) — it is **never** written to `settings.json` in plaintext.

2. **Start typing** — Open any source file and type. After a brief pause (300ms by default), a ghost-text suggestion will appear.

3. **Accept or ignore**:
   - Press `Tab` to accept the suggestion.
   - Press `Escape` to dismiss it.
   - Keep typing to cancel and get a new suggestion.

4. **Toggle on/off** — Run `DeepSeek: Toggle Inline Completion` to enable or disable completions on the fly.

---

## Settings Reference

All settings are under the `deepseek.*` namespace. Open `File → Preferences → Settings` and search for `deepseek`.

| Setting | Type | Default | Range | Description |
|---|---|---|---|---|
| `deepseek.enabled` | `boolean` | `true` | — | Master switch to enable/disable all completions |
| `deepseek.model` | `string` | `"deepseek-chat"` | `"deepseek-chat"`, `"deepseek-coder"` | Which DeepSeek model to query |
| `deepseek.maxTokens` | `number` | `256` | `16`–`4096` | Maximum tokens in the completion response |
| `deepseek.temperature` | `number` | `0.2` | `0`–`2` | Sampling temperature; lower = more deterministic |
| `deepseek.debounceMs` | `number` | `300` | `100`–`2000` | Delay (ms) after last keystroke before requesting |
| `deepseek.contextLines` | `number` | `50` | `10`–`200` | Lines of context sent above and below cursor |
| `deepseek.enabledLanguages` | `string[]` | `[]` | e.g. `["javascript","python"]` | Language IDs to enable; empty = all languages |

### Example `settings.json`

```jsonc
{
  "deepseek.enabled": true,
  "deepseek.model": "deepseek-coder",
  "deepseek.maxTokens": 512,
  "deepseek.temperature": 0.1,
  "deepseek.debounceMs": 500,
  "deepseek.contextLines": 80,
  "deepseek.enabledLanguages": [
    "javascript",
    "typescript",
    "javascriptreact",
    "typescriptreact",
    "python",
    "rust",
    "go"
  ]
}
```

> Note: `deepseek.apiKey` is **not** in the example above — keys are managed via SecretStorage, not `settings.json`.

---

## Commands

| Command ID | Title | Description |
|---|---|---|
| `deepseek.toggleCompletion` | **DeepSeek: Toggle Inline Completion** | Toggles `deepseek.enabled` on/off. Displays a confirmation message. |
| `deepseek.setApiKey` | **DeepSeek: Set API Key** | Opens a masked input box to enter/update your API key. The value is stored in VS Code's global settings. |

Access both via the **Command Palette** (`Ctrl+Shift+P`).

---

## How It Works

### Request Lifecycle

```
User types a character
        │
        ▼
VS Code fires InlineCompletionContext (triggerKind: Automatic)
        │
        ▼
Provider debounces for deepseek.debounceMs (default 300ms)
        │
        ├── User types again → debounce timer resets
        │
        ▼ (no new keystrokes during debounce window)
Extract prefix (code before cursor) and suffix (code after cursor)
        │
        ▼
Build FIM-style prompt with <PREFIX> / <CURSOR> / <SUFFIX>
        │
        ▼
POST to https://api.deepseek.com/v1/chat/completions
        │
        ├── New keystroke → AbortController aborts the in-flight request
        │
        ▼
Parse response, extract completion text, strip markdown fences
        │
        ▼
Return vscode.InlineCompletionItem → rendered as ghost text
```

### Prompt Structure

The extension does not rely on native Fill-in-the-Middle (FIM) API support. Instead, it constructs a structured chat message:

**System message:**
```
You are an expert inline code completion assistant.
You complete code in the {language} programming language.

RULES:
1. Return ONLY the code that should appear at the cursor position.
2. Do NOT repeat the prefix or suffix.
3. Do NOT include any explanations, markdown fences, or commentary.
4. Complete the current statement/expression logically.
5. If the cursor is mid-identifier, complete that identifier naturally.
6. If there is nothing meaningful to complete, return an empty response.
7. Maintain the same indentation style as the surrounding code.
8. Multi-line completions are acceptable when appropriate.
```

**User message:**
```
Complete the code at the <CURSOR> position in the following {language} file.

<PREFIX>
{last N lines of code before cursor}
</PREFIX>

<CURSOR>

<SUFFIX>
{next N lines of code after cursor}
</SUFFIX>

Return ONLY the code that replaces <CURSOR>. Do not wrap in backticks.
```

Context is truncated: prefix keeps the **tail** (closest to cursor, up to ~2000 chars), suffix keeps the **head** (closest to cursor, up to ~1000 chars).

### Response Extraction

The raw model response goes through a cleanup pipeline in [`extractCompletion()`](src/deepseekClient.ts):

1. Trim whitespace.
2. Strip markdown code fences (` ``` `) if the model wrapped the output.
3. Strip the prefix if the model accidentally repeated it.
4. Return `null` if nothing meaningful remains (prevents showing empty/whitespace ghost text).

---

## Architecture

### File Map

```
aisug/
│
├── package.json                          # Extension manifest, contributes configuration & commands
├── tsconfig.json                         # TypeScript compiler configuration
├── .vscodeignore                         # Files excluded from .vsix packaging
├── .gitignore
│
├── .vscode/
│   ├── launch.json                       # Debug launch config ("Run Extension", "Run Extension (no build)")
│   └── tasks.json                        # Build task definitions (compile, watch)
│
├── src/
│   ├── extension.ts                      # Activation entry point — registers provider + commands
│   ├── deepseekClient.ts                 # HTTPS client for DeepSeek API (chat/completions)
│   └── inlineCompletionProvider.ts       # VS Code InlineCompletionItemProvider implementation
│
└── out/                                  # Compiled JavaScript output (gitignored)
    ├── extension.js
    ├── deepseekClient.js
    └── inlineCompletionProvider.js
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  extension.ts (activate)                                        │
│  ├── Registers DeepSeekInlineCompletionProvider                 │
│  ├── Registers commands: toggleCompletion, setApiKey            │
│  └── Listens for configuration changes                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  inlineCompletionProvider.ts                                    │
│  ├── provideInlineCompletionItems(document, position, context)  │
│  │   ├── Checks: enabled? apiKey? language filter?              │
│  │   ├── Automatic trigger → debouncedComplete()                │
│  │   └── Explicit trigger  → getCompletions() immediately       │
│  ├── getCompletions()                                           │
│  │   ├── Aborts previous request                                │
│  │   ├── Gets prefix (code before cursor)                       │
│  │   ├── Gets suffix (code after cursor)                        │
│  │   ├── Calls client.complete(prefix, suffix, lang, signal)    │
│  │   └── Returns InlineCompletionItem[]                         │
│  └── dispose() — cleanup on deactivate                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  deepseekClient.ts                                              │
│  ├── complete(prefix, suffix, language, signal)                 │
│  │   ├── Reads config (apiKey, model, maxTokens, temperature)   │
│  │   ├── Builds FIM prompt via buildFimPrompt()                 │
│  │   ├── POST via https.request() to api.deepseek.com           │
│  │   ├── Parses JSON response                                   │
│  │   └── Calls extractCompletion() to clean output              │
│  ├── httpsRequest() — raw HTTPS with AbortSignal support        │
│  ├── buildSystemPrompt() — system role instructions             │
│  ├── buildFimPrompt() — constructs <PREFIX>/<CURSOR>/<SUFFIX>   │
│  ├── extractCompletion() — strips fences, prefix repeats        │
│  └── truncateCode() — limits context to max character count     │
└─────────────────────────────────────────────────────────────────┘
```

### Class Diagram

```
┌──────────────────────────────────────────┐
│         InlineCompletionProvider          │
├──────────────────────────────────────────┤
│ - client: DeepSeekClient                 │
│ - debounceTimer: NodeJS.Timeout?         │
│ - abortController: AbortController?      │
├──────────────────────────────────────────┤
│ + provideInlineCompletionItems(...)      │
│ - debouncedComplete(...)                 │
│ - getCompletions(...)                    │
│ - getPrefix(...)                         │
│ - getSuffix(...)                         │
│ + dispose()                              │
└──────────────┬───────────────────────────┘
               │  uses
               ▼
┌──────────────────────────────────────────┐
│            DeepSeekClient                │
├──────────────────────────────────────────┤
│ - apiHost: string                        │
│ - apiPath: string                        │
│ - userAgent: string                      │
├──────────────────────────────────────────┤
│ + complete(prefix, suffix, lang, signal) │
│ - httpsRequest(body, apiKey, signal)     │
│ - buildSystemPrompt(language)            │
│ - buildFimPrompt(prefix, suffix, lang)   │
│ - extractCompletion(raw, prefix)         │
│ - truncateCode(code, maxChars)           │
│ - logError(message)                      │
└──────────────────────────────────────────┘
```

---

## Configuration Recipes

### Minimal latency (fast completions)

```jsonc
{
  "deepseek.debounceMs": 150,
  "deepseek.maxTokens": 128,
  "deepseek.contextLines": 30,
  "deepseek.temperature": 0
}
```

Best for fast typists who want suggestions to appear almost instantly. Shorter context and fewer tokens reduce API latency.

### High quality (thoughtful completions, multi-line)

```jsonc
{
  "deepseek.model": "deepseek-coder",
  "deepseek.debounceMs": 600,
  "deepseek.maxTokens": 1024,
  "deepseek.contextLines": 120,
  "deepseek.temperature": 0.3
}
```

Best for complex codebases where you want full function bodies, closing braces, and multi-line completions. More context helps the model understand intent.

### Python-only, conservative

```jsonc
{
  "deepseek.enabledLanguages": ["python"],
  "deepseek.model": "deepseek-coder",
  "deepseek.temperature": 0.1,
  "deepseek.maxTokens": 256,
  "deepseek.contextLines": 60
}
```

---

## Troubleshooting

### No suggestions appear at all

1. **Check `deepseek.enabled`** — Run `DeepSeek: Toggle Inline Completion` and verify the notification says "Enabled".
2. **Check your API key** — Run `DeepSeek: Set API Key` and ensure a valid key is stored. A migration message in the Extension Host output (`[DeepSeek Inline Completion] Migrated API key from settings to SecretStorage.`) confirms a legacy key was imported.
3. **Check `deepseek.enabledLanguages`** — If non-empty, verify the current file's language ID is in the list. Check the language ID in the VS Code status bar (bottom-right).
4. **Check Output panel** — Open `View → Output`, select the "Extension Host" channel from the dropdown, and look for `[DeepSeek Inline Completion]` log messages.

### Error: "DeepSeek API error 401"

Your API key is invalid or expired. Generate a new key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) and update via `DeepSeek: Set API Key`.

### Error: "DeepSeek API error 429"

You've hit DeepSeek's rate limit. Increase `deepseek.debounceMs` to send fewer requests, or upgrade your DeepSeek API tier.

### Suggestions are slow to appear

- Increase `deepseek.debounceMs` (counter-intuitive but reduces cancelled requests).
- Decrease `deepseek.contextLines` to send less data.
- Decrease `deepseek.maxTokens` for faster generation.
- Check your network latency to `api.deepseek.com`.

### Suggestions are inaccurate or irrelevant

- Set `deepseek.model` to `"deepseek-coder"` for code-specific completions.
- Lower `deepseek.temperature` to `0` or `0.1` for more deterministic output.
- Increase `deepseek.contextLines` to give the model more surrounding context.

### Extension won't activate (no logs in Extension Host output)

- Verify VS Code version ≥ 1.82.0 (`Help → About`).
- Verify `npm run compile` completed without errors.
- Check that `out/` directory contains compiled `.js` files.

---

## Development

### Project Setup

```bash
cd aisug
npm install
npm run compile
```

### Build & Run

| Task | Command | Description |
|---|---|---|
| Compile once | `npm run compile` | Runs `tsc -p ./` |
| Watch mode | `npm run watch` | Recompiles on file changes |
| Launch extension | Press **F5** | Opens Extension Development Host |
| Launch (no rebuild) | Select "Run Extension (no build)" in Run & Debug | Skips the pre-launch build task |

### Debugging

1. Press **F5** to launch the Extension Development Host.
2. Set breakpoints in `src/*.ts` files.
3. Open a file and start typing — breakpoints in `provideInlineCompletionItems` and `complete` will be hit.
4. View logs in the original VS Code window's **Debug Console**.
5. View extension host logs via `View → Output → "Extension Host"`.

### Adding Features

- **Support streaming completions** — Modify `deepseekClient.ts` to set `stream: true` and parse Server-Sent Events (SSE). Requires switching from `https.request` to streaming response handling.
- **Cache recent completions** — Add an LRU cache in `inlineCompletionProvider.ts` keyed by `(document URI, position, prefix hash)`.
- **Multi-line ghost text rendering** — Already supported; the provider returns multi-line strings and VS Code renders them automatically.
- **Context from multiple files** — Enhance `getPrefix()`/`getSuffix()` to include imports or related file snippets by resolving imports from the current document.
- **Status bar indicator** — Add a status bar item in `extension.ts` showing when a request is in-flight, similar to Copilot's spinner.

---

## FAQ

### How is this different from GitHub Copilot?

Copilot uses OpenAI Codex models and sends extensive context (neighboring files, recently viewed tabs). This extension is a lightweight alternative that uses DeepSeek models with only local context (prefix/suffix from the current file). It's fully open-source and you control the API key.

### Does it work offline?

No — every completion requires a network call to `api.deepseek.com`. There is no local model.

### What does it cost?

You pay DeepSeek directly for API usage. See [DeepSeek Pricing](https://platform.deepseek.com/pricing). At the time of writing, `deepseek-chat` is significantly cheaper per token than GPT-4.

### Can I use it alongside Copilot?

Yes. VS Code supports multiple inline completion providers. Copilot's suggestions take priority; this extension's suggestions appear when Copilot has none. You can toggle either independently.

### What languages are supported?

Any language VS Code recognizes (all language IDs). The model's quality will vary by language — `deepseek-coder` is trained on dozens of programming languages.

### How do I report a bug or request a feature?

File an issue on the project repository with:
- VS Code version (`Help → About`)
- Extension settings (`deepseek.*` from your `settings.json`, with API key redacted)
- Steps to reproduce
- Relevant Extension Host logs

---

## License

MIT
