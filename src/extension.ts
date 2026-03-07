import * as fs from 'fs';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  function updateStatus(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      statusBar.text = 'Helm: no workspace';
      statusBar.show();
      return;
    }

    const hasHelmfile = workspaceFolders.some((folder) => {
      const helmfilePath = vscode.Uri.joinPath(folder.uri, 'helmfile.yaml').fsPath;
      return fs.existsSync(helmfilePath);
    });

    if (hasHelmfile) {
      statusBar.text = 'Helm: active';
    } else {
      statusBar.text = 'Helm: no helmfile';
    }
    statusBar.show();
  }

  // Initial update
  updateStatus();

  // Update when workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(updateStatus)
  );
}

export function deactivate(): void {}
