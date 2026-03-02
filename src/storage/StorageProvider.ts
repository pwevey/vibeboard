import * as vscode from 'vscode';
import { VBWorkspaceData, createDefaultWorkspaceData } from './models';
import { STORAGE_DIR, STORAGE_FILE, STORAGE_WRITE_DEBOUNCE_MS } from '../utils/constants';

/**
 * StorageProvider handles reading/writing the workspace JSON data file.
 * Uses vscode.workspace.fs for remote workspace compatibility.
 */
export class StorageProvider {
  private data: VBWorkspaceData;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private storageUri: vscode.Uri | null = null;

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

    try {
      // Ensure directory exists
      await vscode.workspace.fs.createDirectory(dirUri);
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
