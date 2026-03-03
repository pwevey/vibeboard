/**
 * Minimal vscode module mock for unit tests.
 * Only stubs what StorageProvider and services import.
 */
export const workspace = {
  workspaceFolders: [],
  fs: {
    readFile: async () => Buffer.from('{}'),
    writeFile: async () => {},
    createDirectory: async () => {},
  },
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
};

export class Uri {
  static joinPath(..._args: any[]): any { return {}; }
}

export class RelativePattern {
  constructor(_base: any, _pattern: string) {}
}

export const window = {
  showInformationMessage: async (..._args: any[]) => undefined,
  showWarningMessage: async (..._args: any[]) => undefined,
  showErrorMessage: async (..._args: any[]) => undefined,
};

export const lm = {
  selectChatModels: async () => [],
};

export const LanguageModelChatMessage = {
  User: (text: string) => ({ role: 'user', content: text }),
};

export const commands = {
  executeCommand: async () => {},
};

export const env = {
  clipboard: {
    writeText: async () => {},
  },
};
