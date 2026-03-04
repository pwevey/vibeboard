import * as vscode from 'vscode';
import { VBWorkspaceData, createDefaultWorkspaceData } from './models';
import { STORAGE_DIR, STORAGE_FILE, STORAGE_WRITE_DEBOUNCE_MS, BACKUP_DIR, AUTO_BACKUP_MIN_INTERVAL_MS } from '../utils/constants';

/**
 * StorageProvider handles reading/writing the workspace JSON data file.
 * Uses vscode.workspace.fs for remote workspace compatibility.
 * Includes automatic background backups to .vibeboard/backups/.
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
   */
  async initialize(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder open');
    }

    const dirUri = vscode.Uri.joinPath(workspaceFolder.uri, STORAGE_DIR);
    this.storageUri = vscode.Uri.joinPath(dirUri, STORAGE_FILE);
    this.backupDirUri = vscode.Uri.joinPath(dirUri, BACKUP_DIR);

    try {
      // Ensure directory exists
      await vscode.workspace.fs.createDirectory(dirUri);
    } catch {
      // Directory may already exist
    }

    try {
      await vscode.workspace.fs.createDirectory(this.backupDirUri);
    } catch {
      // Directory may already exist
    }

    await this.load();
  }

  /**
   * Load data from the JSON file. Creates default if not found.
   */
  private async load(): Promise<void> {
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
      // File doesn't exist yet or is corrupted — use defaults
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

    const content = JSON.stringify(this.data, null, 2);
    const bytes = Buffer.from(content, 'utf-8');
    await vscode.workspace.fs.writeFile(this.storageUri, bytes);

    // Trigger auto-backup in background (non-blocking)
    this.maybeAutoBackup(content).catch(() => { /* silently ignore backup errors */ });
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
    if (now - this.lastBackupTime < AUTO_BACKUP_MIN_INTERVAL_MS) { return; }
    this.lastBackupTime = now;

    try {
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
    const content = JSON.stringify(this.data, null, 2);
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
