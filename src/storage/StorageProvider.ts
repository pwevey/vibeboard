import * as vscode from 'vscode';
import { VBWorkspaceData, createDefaultWorkspaceData } from './models';
import { STORAGE_FILE, STORAGE_WRITE_DEBOUNCE_MS, BACKUP_DIR } from '../utils/constants';

/**
 * StorageProvider handles reading/writing the global JSON data file.
 * Uses vscode.workspace.fs for remote workspace compatibility.
 * Data is stored in VS Code's global storage directory (per-user, cross-workspace).
 * Includes automatic background backups to globalStorage/backups/.
 */
export class StorageProvider {
  private data: VBWorkspaceData;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private storageUri: vscode.Uri | null = null;
  private backupDirUri: vscode.Uri | null = null;
  private lastBackupTime: number = 0;

  constructor() {
    this.data = createDefaultWorkspaceData();
  }

  /**
   * Initialize storage — resolve file path and load data.
   * Uses VS Code's globalStorageUri so data is shared across all workspaces.
   * On first run, migrates any existing workspace-scoped .vibeboard/data.json.
   */
  async initialize(globalStorageUri: vscode.Uri): Promise<void> {
    const dirUri = globalStorageUri;
    this.storageUri = vscode.Uri.joinPath(dirUri, STORAGE_FILE);
    this.backupDirUri = vscode.Uri.joinPath(dirUri, BACKUP_DIR);

    // Ensure the global storage directory exists
    try { await vscode.workspace.fs.createDirectory(dirUri); } catch { /* already exists */ }

    await this.load(dirUri);

    // Migrate workspace-scoped data if present and global data is empty/default
    await this.migrateFromWorkspace();
  }

  /**
   * Load data from the JSON file. Creates default if not found.
   */
  private async load(dirUri?: vscode.Uri): Promise<void> {
    if (!this.storageUri) {
      return;
    }

    try {
      const raw = await vscode.workspace.fs.readFile(this.storageUri);
      const text = Buffer.from(raw).toString('utf-8');
      const parsed = JSON.parse(text) as VBWorkspaceData;

      // Version check — future migration hook
      if (parsed.version === 1) {
        this.data = parsed;
      } else {
        // Unknown version — migrate or use default
        console.warn(`[VB] Unknown data version: ${parsed.version}. Using defaults.`);
        this.data = createDefaultWorkspaceData();
      }
    } catch {
      // File doesn't exist yet or is corrupted — ensure directory exists and write defaults
      if (dirUri) {
        try { await vscode.workspace.fs.createDirectory(dirUri); } catch { /* already exists */ }
      }
      this.data = createDefaultWorkspaceData();
      await this.flush();
    }
  }

  /**
   * Get a snapshot of current data.
   */
  getData(): VBWorkspaceData {
    return this.data;
  }

  /**
   * Replace the entire data object and schedule a write.
   */
  setData(data: VBWorkspaceData): void {
    this.data = data;
    this.scheduleSave();
  }

  /**
   * Debounced save — coalesces rapid writes.
   */
  private scheduleSave(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.flush();
    }, STORAGE_WRITE_DEBOUNCE_MS);
  }

  /**
   * Immediately write data to disk.
   */
  async flush(): Promise<void> {
    if (!this.storageUri) {
      return;
    }

    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    const content = JSON.stringify(this.data);
    const bytes = Buffer.from(content, 'utf-8');
    await vscode.workspace.fs.writeFile(this.storageUri, bytes);

    // Trigger auto-backup in background (non-blocking)
    this.maybeAutoBackup(content).catch(() => { /* silently ignore backup errors */ });
  }

  /**
   * Migrate data from old workspace-scoped .vibeboard/data.json into global storage.
   * Only runs once — if global data already has sessions/tasks it's a no-op.
   * After a successful migration the old workspace file is renamed to data.json.migrated
   * so it won't be imported again.
   */
  private async migrateFromWorkspace(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return; }

    const oldFileUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vibeboard', 'data.json');

    try {
      const raw = await vscode.workspace.fs.readFile(oldFileUri);
      const text = Buffer.from(raw).toString('utf-8');
      const oldData = JSON.parse(text) as VBWorkspaceData;

      if (!oldData || oldData.version !== 1) { return; }

      // Only migrate if the old data has meaningful content
      const hasContent = (oldData.sessions?.length > 0 || oldData.tasks?.length > 0);
      if (!hasContent) { return; }

      // Merge: append old sessions/tasks/projects that don't already exist in global data
      const existingSessionIds = new Set(this.data.sessions.map((s) => s.id));
      const existingTaskIds = new Set(this.data.tasks.map((t) => t.id));
      const existingProjectIds = new Set((this.data.projects || []).map((p) => p.id));

      let merged = false;

      for (const session of oldData.sessions) {
        if (!existingSessionIds.has(session.id)) {
          this.data.sessions.push(session);
          merged = true;
        }
      }

      for (const task of oldData.tasks) {
        if (!existingTaskIds.has(task.id)) {
          this.data.tasks.push(task);
          merged = true;
        }
      }

      if (oldData.projects) {
        if (!this.data.projects) { this.data.projects = []; }
        for (const project of oldData.projects) {
          if (!existingProjectIds.has(project.id)) {
            this.data.projects.push(project);
            merged = true;
          }
        }
      }

      // Carry over boards if global has none
      if (oldData.boards?.length > 0 && (!this.data.boards || this.data.boards.length === 0)) {
        this.data.boards = oldData.boards;
        this.data.activeBoardId = oldData.activeBoardId;
        merged = true;
      }

      // Carry over Jira mappings if not set globally
      if (oldData.jiraProjectMapping && !this.data.jiraProjectMapping) {
        this.data.jiraProjectMapping = oldData.jiraProjectMapping;
        merged = true;
      }
      if (oldData.jiraEpicMapping && !this.data.jiraEpicMapping) {
        this.data.jiraEpicMapping = oldData.jiraEpicMapping;
        merged = true;
      }
      if (oldData.jiraStatusMapping && !this.data.jiraStatusMapping) {
        this.data.jiraStatusMapping = oldData.jiraStatusMapping;
        merged = true;
      }

      // Carry over active session/project if global has none
      if (oldData.activeSessionId && !this.data.activeSessionId) {
        this.data.activeSessionId = oldData.activeSessionId;
        merged = true;
      }
      if (oldData.activeProjectId && !this.data.activeProjectId) {
        this.data.activeProjectId = oldData.activeProjectId;
        merged = true;
      }

      if (merged) {
        await this.flush();

        // Rename old file so it isn't migrated again
        const migratedUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vibeboard', 'data.json.migrated');
        try { await vscode.workspace.fs.rename(oldFileUri, migratedUri, { overwrite: true }); } catch { /* best-effort */ }

        vscode.window.showInformationMessage(
          `Vibe Board: Migrated ${this.data.sessions.length} session(s) and ${this.data.tasks.length} task(s) from workspace storage to global storage.`
        );
      }
    } catch {
      // Old file doesn't exist or is corrupted — nothing to migrate
    }
  }

  /**
   * Create an auto-backup if enough time has elapsed since the last one.
   */
  private async maybeAutoBackup(content: string): Promise<void> {
    if (!this.backupDirUri) { return; }

    const config = vscode.workspace.getConfiguration('vibeboard');
    const enabled = config.get<boolean>('autoBackup', true);
    if (!enabled) { return; }

    const now = Date.now();
    const intervalMin = config.get<number>('autoBackupIntervalMin', 5);
    const intervalMs = Math.max(1, Math.min(60, intervalMin)) * 60 * 1000;
    if (now - this.lastBackupTime < intervalMs) { return; }
    this.lastBackupTime = now;

    try {
      // Ensure backup directory exists (created lazily, not during activation)
      try { await vscode.workspace.fs.createDirectory(this.backupDirUri); } catch { /* exists */ }

      // Create timestamped backup file
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupFileName = `data-backup-${ts}.json`;
      const backupUri = vscode.Uri.joinPath(this.backupDirUri, backupFileName);
      await vscode.workspace.fs.writeFile(backupUri, Buffer.from(content, 'utf-8'));

      // Rotate old backups
      await this.rotateBackups();
    } catch (err) {
      console.warn('[VB] Auto-backup failed:', err);
    }
  }

  /**
   * Delete the oldest backup files when exceeding the configured max count.
   */
  private async rotateBackups(): Promise<void> {
    if (!this.backupDirUri) { return; }

    const config = vscode.workspace.getConfiguration('vibeboard');
    const maxCount = config.get<number>('autoBackupMaxCount', 10);

    try {
      const entries = await vscode.workspace.fs.readDirectory(this.backupDirUri);
      const backupFiles = entries
        .filter(([name, type]) => type === vscode.FileType.File && name.startsWith('data-backup-') && name.endsWith('.json'))
        .map(([name]) => name)
        .sort(); // Lexicographic sort works because the timestamp format is consistent

      if (backupFiles.length > maxCount) {
        const toDelete = backupFiles.slice(0, backupFiles.length - maxCount);
        for (const file of toDelete) {
          const fileUri = vscode.Uri.joinPath(this.backupDirUri, file);
          await vscode.workspace.fs.delete(fileUri);
        }
      }
    } catch {
      // Silently ignore rotation errors
    }
  }

  /**
   * Synchronous flush for use in deactivate (fire-and-forget).
   */
  flushSync(): void {
    if (!this.storageUri) { return; }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const content = JSON.stringify(this.data);
    const bytes = Buffer.from(content, 'utf-8');
    vscode.workspace.fs.writeFile(this.storageUri, bytes);
  }

  /**
   * Clean up timers on dispose.
   */
  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }
}
