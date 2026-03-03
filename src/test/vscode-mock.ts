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
  getConfiguration: () => ({
    get: (_key: string, defaultValue: any) => defaultValue,
  }),
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
  textDocuments: [],
  asRelativePath: (uri: any) => uri?.fsPath || uri?.path || '',
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
  withProgress: async (_options: any, task: any) => {
    const progress = { report: () => {} };
    const token = { onCancellationRequested: () => ({ dispose: () => {} }) };
    return task(progress, token);
  },
};

export const ProgressLocation = {
  Notification: 15,
  SourceControl: 1,
  Window: 10,
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
