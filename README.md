# Vibe Board

**AI Brainstorm & Prompt Workflow for VSCode**

A lightweight Kanban-style sidebar for developers who work with AI assistants. Capture ideas, organize prompts, and track your workflow — all without leaving the editor.

## Features

- **Session-based workflow** — Start a session when you sit down, end it when you're done. Automatic timer tracks how long you've been going.
- **Kanban columns** — Organize tasks across Up Next, Backlog, Completed, and Notes.
- **Quick add** — Add tasks instantly with customizable tags (Feature, Bug, Refactor, Note, Plan, Todo) and target columns.
- **Inline editing** — Double-click any task title or hit the edit button to update title, description, and tag in-place.
- **Drag & drop** — Move tasks between columns with visual insertion indicators.
- **Context menus** — Right-click any task card for quick actions: edit, move, complete, or delete.
- **Search & filter** — Find tasks by text or filter by tag across all columns.
- **Live stats** — See total, completed, up-next, and backlog counts at a glance.
- **Session history** — Review past sessions with duration, completion stats, and tag breakdowns.
- **Delete confirmation** — Prevents accidental task deletion.
- **Session summary** — End-of-session popup showing duration, tasks completed by tag, and carry-over count.
- **Task carry-over** — Unfinished tasks automatically move to your next session (configurable).
- **Keyboard shortcuts** — `Ctrl+N` to focus quick add, `Ctrl+H` to toggle history, `Escape` to close overlays.
- **Theme integration** — Follows your VSCode theme automatically (light, dark, high contrast).

## Getting Started

1. Click the **Vibe Board** icon in the Activity Bar (left sidebar).
2. Press **Start Session** to begin.
3. Add tasks, drag them around, check them off as you go.
4. Press **End Session** to see your summary.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `Vibe Board: Start Session` | — | Start a new work session |
| `Vibe Board: End Session` | — | End the current session |
| `Vibe Board: Quick Add Task` | `Ctrl+Shift+V` | Focus the quick-add input |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vibeboard.autoPromptSession` | `true` | Prompt to start a session when VSCode opens |
| `vibeboard.carryOverTasks` | `true` | Carry unfinished tasks to the next session |

## Data Storage

All data is stored locally in your workspace at `.vibeboard/data.json`. No external services, no cloud sync, no telemetry. Add `.vibeboard/` to your `.gitignore` if you don't want to commit session data.

## Development

```bash
npm install
npm run build     # One-time build
npm run watch     # Watch mode for development
```

Press `F5` in VSCode to launch the Extension Development Host.

## Architecture

- **Extension Host**: TypeScript (CommonJS) — session management, task CRUD, workspace storage
- **Webview**: Vanilla TypeScript (IIFE) — Kanban UI with native HTML5 drag-and-drop
- **Bundler**: esbuild with dual-bundle config
- **Storage**: Workspace-scoped JSON with debounced writes

## License

MIT
