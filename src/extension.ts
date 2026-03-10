import * as vscode from 'vscode';
import { detectLayout } from './layout';
import { registerCompletionProvider } from './completionProvider';
import { registerDefinitionProvider } from './definitionProvider';
import { registerHoverProvider } from './hoverProvider';
import { registerOrphanDiagnostics } from './orphanDiagnostics';
import { registerCacheInvalidation } from './valuesCache';
import {
  getResolvedValues,
  getResolvedValuesCustom,
  getResolvedValuesOverrideFolder,
  ResolvedValues,
  ValuesResolverContext,
} from './valuesResolver';

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  context.subscriptions.push(statusBar);

  function getConfig(folder: vscode.WorkspaceFolder) {
    const config = vscode.workspace.getConfiguration('helmValues', folder.uri);
    return {
      helmfilePath: config.get<string>('helmfilePath') ?? 'helmfile.yaml',
      chartPath: config.get<string>('chartPath'),
      baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
      overridesDir: config.get<string>('overridesDir') ?? 'overrides',
      secretsFilePath: config.get<string>('secretsFilePath'),
      environments: config.get<string[]>('environments'),
      valuesBasePath: config.get<string>('valuesBasePath') ?? '.',
      valuesFilePattern: config.get<string>('valuesFilePattern'),
    };
  }

  function updateStatus(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      statusBar.text = 'Helm: no workspace';
      statusBar.show();
      return;
    }

    let envCount = 0;
    for (const folder of workspaceFolders) {
      const config = getConfig(folder);
      const layout = detectLayout(folder, {
        helmfilePath: config.helmfilePath,
        chartPath: config.chartPath,
        baseValuesFile: config.baseValuesFile,
        overridesDir: config.overridesDir,
        environments: config.environments,
        valuesBasePath: config.valuesBasePath,
        valuesFilePattern: config.valuesFilePattern,
      });
      if (layout) {
        if (layout.layout === 'helmfile' || layout.layout === 'override-folder' || layout.layout === 'custom') {
          envCount += layout.environments.length;
        } else {
          envCount += 1; // standalone = 1 env
        }
      }
    }

    if (envCount > 0) {
      statusBar.text = `Helm: ${envCount} env${envCount === 1 ? '' : 's'}`;
    } else {
      statusBar.text = 'Helm: no chart';
    }
    statusBar.show();
  }

  updateStatus();

  registerHoverProvider(context);
  registerDefinitionProvider(context);
  registerCompletionProvider(context);
  registerCacheInvalidation(context); // Before orphan diagnostics so config change clears cache first
  registerOrphanDiagnostics(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(updateStatus),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('helmValues')) updateStatus();
    })
  );
}

/** Resolve values for a given env. Returns null if layout not detected. */
export function resolveValuesForEnv(
  docUri: vscode.Uri,
  envName: string
): ResolvedValues | null {
  const folder = vscode.workspace.getWorkspaceFolder(docUri);
  if (!folder) return null;

  const config = vscode.workspace.getConfiguration('helmValues', folder.uri);
  const layout = detectLayout(folder, {
    helmfilePath: config.get<string>('helmfilePath') ?? 'helmfile.yaml',
    chartPath: config.get<string>('chartPath'),
    baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
    overridesDir: config.get<string>('overridesDir') ?? 'overrides',
    environments: config.get<string[]>('environments'),
    valuesBasePath: config.get<string>('valuesBasePath') ?? '.',
    valuesFilePattern: config.get<string>('valuesFilePattern'),
  });

  if (!layout) return null;

  if (layout.layout === 'custom') {
    return getResolvedValuesCustom(
      layout.rootPath,
      layout.chartPath,
      config.get<string>('baseValuesFile') ?? 'values.yaml',
      layout.valuesBasePath,
      layout.valuesFilePattern,
      envName
    );
  }

  if (layout.layout === 'helmfile') {
    const ctx: ValuesResolverContext = {
      workspaceRoot: layout.rootPath,
      chartPath: layout.chartPath,
      baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
      valueFileTemplates: layout.valueFileTemplates,
      secretsFilePath: config.get<string>('secretsFilePath'),
    };
    return getResolvedValues(ctx, envName);
  }

  if (layout.layout === 'override-folder') {
    return getResolvedValuesOverrideFolder(
      layout.rootPath,
      layout.chartPath,
      config.get<string>('baseValuesFile') ?? 'values.yaml',
      config.get<string>('overridesDir') ?? 'overrides',
      envName
    );
  }

  // standalone: single "default" env
  if (envName === 'default') {
    const ctx: ValuesResolverContext = {
      workspaceRoot: layout.rootPath,
      chartPath: layout.chartPath,
      baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
      valueFileTemplates: [],
    };
    return getResolvedValues(ctx, envName);
  }
  return null;
}

/** Get all env names for the workspace containing docUri. */
export function getEnvNames(docUri: vscode.Uri): string[] {
  const folder = vscode.workspace.getWorkspaceFolder(docUri);
  if (!folder) return [];

  const config = vscode.workspace.getConfiguration('helmValues', folder.uri);
  const layout = detectLayout(folder, {
    helmfilePath: config.get<string>('helmfilePath') ?? 'helmfile.yaml',
    chartPath: config.get<string>('chartPath'),
    baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
    overridesDir: config.get<string>('overridesDir') ?? 'overrides',
    environments: config.get<string[]>('environments'),
    valuesBasePath: config.get<string>('valuesBasePath') ?? '.',
    valuesFilePattern: config.get<string>('valuesFilePattern'),
  });

  if (!layout) return [];
  if (layout.layout === 'helmfile' || layout.layout === 'override-folder' || layout.layout === 'custom') {
    return layout.environments;
  }
  return ['default'];
}

export function deactivate(): void {}
