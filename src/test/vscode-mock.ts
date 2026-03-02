/**
 * Minimal vscode module mock for unit tests.
 * Only stubs what StorageProvider imports.
 */
export const workspace = {
  workspaceFolders: [],
  fs: {
    readFile: async () => Buffer.from('{}'),
    writeFile: async () => {},
    createDirectory: async () => {},
  },
};

export class Uri {
  static joinPath(..._args: any[]): any { return {}; }
}
