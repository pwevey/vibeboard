/**
 * Mock StorageProvider for unit tests.
 * Keeps data in memory — no vscode dependency.
 */
import { VBWorkspaceData, createDefaultWorkspaceData } from '../storage/models';

export class MockStorageProvider {
  private data: VBWorkspaceData;

  constructor(initial?: Partial<VBWorkspaceData>) {
    this.data = { ...createDefaultWorkspaceData(), ...initial } as VBWorkspaceData;
  }

  getData(): VBWorkspaceData {
    return this.data;
  }

  setData(data: VBWorkspaceData): void {
    this.data = data;
  }

  async initialize(): Promise<void> {}
  async flush(): Promise<void> {}
  dispose(): void {}
}
