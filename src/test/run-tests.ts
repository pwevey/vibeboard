/**
 * Test runner — registers vscode mock then runs all test files.
 */
import Module from 'module';
import path from 'path';

// Register a mock for 'vscode' module
const originalResolve = (Module as any)._resolveFilename;
const vscodeMockPath = path.join(__dirname, 'vscode-mock');

(Module as any)._resolveFilename = function (request: string, ...args: any[]) {
  if (request === 'vscode') {
    return originalResolve.call(this, vscodeMockPath, ...args);
  }
  return originalResolve.call(this, request, ...args);
};

// Run test files
import('./taskManager.test');
import('./sessionManager.test');
import('./automation.test');
