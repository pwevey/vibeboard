# Build Board

**AI-Powered Kanban Workflow for VS Code**

A full-featured Kanban sidebar for developers who work with AI assistants. Plan tasks, send them to Copilot for automated implementation, manage Jira issues, and track your entire development workflow — all without leaving the editor.

## Features

### Core Board
- **Session-based workflow** — Start a session when you sit down, end it when you're done. Automatic timer tracks duration.
- **Kanban columns** — Organize tasks across Up Next, Backlog, Completed, and Notes.
- **Quick add** — Add tasks instantly with customizable tags (Feature, Bug, Refactor, Note, Plan, Todo) and target columns.
- **Inline editing** — Edit title, description, tag, and due date in-place with a multi-line editor.
- **Drag & drop** — Move tasks between columns with visual insertion indicators.
- **Context menus** — Right-click any task for quick actions: edit, move, complete, delete, or create a branch.
- **Search & filter** — Find tasks by text or filter by tag across all columns.
- **Live stats bar** — Total, completed, up-next, backlog, and active timer counts at a glance.
- **Multi-board support** — Create multiple boards within a session to organize different workstreams.
- **Task carry-over** — Unfinished tasks automatically move to your next session (configurable).
- **Undo / redo** — Revert accidental edits, moves, or deletions.

### Subtasks
- **AI-generated subtasks** — Use AI Break to Subtasks to split a task into subtasks linked to the parent.
- **Manual subtasks** — Add subtasks manually via the context menu or inline input on parent cards.
- **Nested checklists** — Parent task cards show a checklist of child tasks with completion checkboxes.
- **Progress bar** — Visual progress indicator on parent cards showing subtask completion.
- **Auto-complete parent** — When all subtasks are done, the parent task is automatically marked complete.

### Due Dates
- **Date picker** — Set due dates on tasks via the edit card.
- **Overdue indicators** — Red badge for overdue tasks, yellow badge for tasks due within 2 days.
- **Days remaining** — Badge shows how many days until (or past) the due date.

### Git Branch Linking
- **Create branch from task** — Right-click a task → Create Branch to generate and checkout a descriptive branch.
- **Branch badge** — Linked branch name appears on the task card.
- **Automation branching** — Optionally create per-task branches during automation runs.

### AI & Automation
- **AI task breakdown** — Right-click a task and let the AI split it into implementation subtasks.
- **Copilot automation loop** — Queue tasks and send them to Copilot Chat one-by-one for automated implementation.
- **Confidence scoring** — AI reviews file changes and assigns a confidence score; auto-approve above threshold.
- **Two-tier timeout** — Configurable idle timeout with a short confirmation window before marking a task for review.
- **Approve / Reject / Revise / Skip** — Full review controls during automation: approve changes, reject and revert, request revisions, or skip.
- **Pause / Resume / Cancel** — Control the automation queue at any time.
- **Retry** — Re-send a failed or rejected task from the top bar.

### Timer Tracking
- **Per-task timers** — Click the clock icon to start/stop tracking time on individual tasks.
- **Session timer** — Automatic session-level timer with pause/resume support.
- **Time display** — Tracked time shown on task cards and in stats.

### Analytics Dashboard
- **Key metrics** — Completion rate, tasks per session, average session duration, total time tracked.
- **Tag distribution** — Bar chart showing task counts by tag with color coding.
- **Overdue count** — Highlighted stat when tasks are past their due date.
- **Project scoping** — Analytics filter by active project.

### Projects
- **Project grouping** — Organize sessions into named projects with color labels.
- **Workspace-aware** — Projects are grouped by workspace folder.
- **Project filtering** — Filter session history, analytics, and exports by project.

### Jira Integration
- **Export to Jira** — Create Jira issues from tasks with configurable status/priority mapping.
- **Import from Jira** — Pull issues from Jira via JQL into Build Board.
- **Secure credentials** — Jira credentials stored in OS keychain via VS Code's SecretStorage API.

### Export / Import
- **JSON** — Full data backup and restore (sessions, tasks, settings).
- **CSV** — Spreadsheet-ready export with session info and summary totals.
- **Markdown** — Human-readable report with summary stats and session history.
- **Import** — Restore from a JSON export or `data.json` backup.

### Templates
- **Task templates** — Create reusable task templates from the context menu.
- **Quick apply** — Apply a template to pre-fill title, description, and tag.

### Voice Input
- **Voice-to-task** — Use the microphone button to add tasks via speech (browser Speech Recognition API).

### Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | Focus quick-add input |
| `Ctrl+H` | Toggle session history |
| `Escape` | Close overlays / modals |
| `Ctrl+Z` | Undo last action |
| `Ctrl+Shift+Z` | Redo |

## Getting Started

1. Click the **Build Board** icon in the Activity Bar (left sidebar).
2. Press **Start Session** to begin.
3. Add tasks, drag them between columns, check off completed work.
4. Right-click tasks for AI subtask breakdown, manual subtasks, branch creation, and more.
5. Press **End Session** to see your summary and analytics.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `Build Board: Start Session` | — | Start a new work session |
| `Build Board: End Session` | — | End the current session |
| `Build Board: Quick Add Task` | `Ctrl+Shift+V` | Focus the quick-add input |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `buildboard.autoPromptSession` | `true` | Prompt to start a session when VS Code opens |
| `buildboard.carryOverTasks` | `true` | Carry unfinished tasks to the next session |
| `buildboard.automationAutoApproveThreshold` | `100` | Minimum AI confidence (0–100%) to auto-approve |
| `buildboard.automationNoActivityTimeout` | `30` | Seconds to wait for file changes during automation (5–300) |
| `buildboard.automationBranching` | `false` | Create a git branch per automation task |

## Data Storage

All data is stored locally in VS Code's global storage directory, shared across all workspaces. No external services, no cloud sync, no telemetry.

## Development

```bash
npm install
npm run build     # One-time build
npm run watch     # Watch mode for development
npm test          # Run tests
```

Press `F5` in VS Code to launch the Extension Development Host.

## Architecture

| Module | Purpose |
|--------|---------|
| `src/extension.ts` | Extension activation and command registration |
| `src/core.ts` | Shared core exports |
| `src/ui/webview/main.ts` | All webview UI logic (vanilla TypeScript IIFE) |
| `src/ui/MessageHandler.ts` | Webview ↔ extension message dispatch |
| `src/ui/WebviewProvider.ts` | VS Code webview provider |
| `src/storage/models.ts` | All shared TypeScript types and interfaces |
| `src/storage/StorageProvider.ts` | JSON file persistence with debounced writes |
| `src/tasks/TaskManager.ts` | Task CRUD with undo/redo |
| `src/session/SessionManager.ts` | Session lifecycle management |
| `src/services/AutomationService.ts` | Multi-task Copilot automation loop |
| `src/services/JiraService.ts` | Jira REST API v3 integration |
| `src/services/index.ts` | CopilotAIService (vscode.lm API) |
| `src/services/SecretStorageService.ts` | OS keychain credential storage |
| `src/utils/git.ts` | Git branch utilities |

- **Bundler**: esbuild with dual-bundle config (extension + webview)
- **Storage**: Global-scoped JSON with debounced writes

## License

MIT
