# Vibe Board — Copilot Instructions

## Project Overview
Vibe Board is a VS Code extension providing a Kanban-style sidebar for AI-assisted development.
- **Extension host**: TypeScript/CommonJS (`src/`) bundled to `dist/extension.js` and `dist/core.js`
- **Webview UI**: Vanilla TypeScript IIFE (`src/ui/webview/main.ts`) bundled to `dist/webview/`
- **Bundler**: esbuild (`esbuild.config.mjs`) — run `npm run build` or `npm run watch`
- **Storage**: Global storage (`context.globalStorageUri/data.json`), shared across all workspaces
- **Tests**: `src/test/` — run with `npm test`

## Coding Standards

### Always add comments
- Add JSDoc comments to all new functions, classes, and methods.
- Add inline comments explaining non-obvious logic, especially in `MessageHandler.ts`, `AutomationService.ts`, and `main.ts` (webview).
- Comment any workarounds or browser/VS Code API quirks.

### Code style
- Use `escapeAttr()` (not `escapeHtml()`) when injecting strings into HTML attribute values.
- Prefer `const`/`let`, strict equality, and explicit types.
- Keep the webview (`main.ts`) as vanilla TypeScript — no framework imports.
- Message types between webview and extension are defined in `src/storage/models.ts` (`WebviewToExtensionMessage`). Update them when adding new message types.

## Workflow Requirements

### After making code changes
1. **Run the build**: `npm run build` — confirm it succeeds before considering a task done.
2. **Run tests**: `npm test` — fix any failures before committing.
3. **Commit and push**: Use a clear, conventional commit message:
   - `fix:` for bug fixes
   - `feat:` for new features
   - `refactor:` for restructuring without behavior change
   - `docs:` for documentation-only changes
   - Example: `git add -A && git commit -m "fix: restore JQL filter value on back navigation" && git push`

### Documentation
- Update the **built-in help docs** when adding or changing user-facing features, commands, settings, or keyboard shortcuts.
  - The help system lives in `src/ui/webview/main.ts` inside the `renderHelpContent(section)` function.
  - It has 13 tabbed sections: Getting Started, Tasks, Board, Sessions, Projects, Timers, Templates, AI Features, Automation, Voice Input, Attachments, Export/Import, and Shortcuts.
  - Each section returns an HTML string from a `switch` case — add or update the relevant section's HTML when a feature changes.
  - The `searchHelpSections()` function indexes all tabs for search — new content is automatically searchable.
- **Do NOT update help docs** for internal UX refinements, default-value tweaks, sort-order changes, or other behind-the-scenes improvements that users don't need to know about. Only document things a user would actively look up or need instructions for.
- Update `README.md` when adding or changing commands, settings, or architecture (e.g., new services/modules).

## Key Files
| File | Purpose |
|---|---|
| `src/ui/webview/main.ts` | All webview UI logic (~6000 lines) |
| `src/ui/MessageHandler.ts` | Webview ↔ extension message dispatch |
| `src/storage/models.ts` | All shared TypeScript types |
| `src/services/AutomationService.ts` | Multi-task Copilot automation loop |
| `src/services/JiraService.ts` | Jira REST API v3 integration |
| `src/services/index.ts` | CopilotAIService (vscode.lm API) |
| `src/services/SecretStorageService.ts` | OS keychain credential storage |
