import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectLayout } from './layout';
import {
  flattenLeafKeys,
  getBaseValues,
  getOverrideOnlyValues,
  getOverrideOnlyValuesCustom,
  getOverrideOnlyValuesOverrideFolder,
  getResolvedValues,
  getResolvedValuesCustom,
  getResolvedValuesOverrideFolder,
  getValueAtPath,
  ValuesResolverContext,
} from './valuesResolver';

const VALUES_PATH_REGEX = /\.Values\.([a-zA-Z0-9_.-]+)/g;

function offsetToPosition(text: string, offset: number): vscode.Position {
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) ?? []).length;
  const lastNewline = before.lastIndexOf('\n');
  const character = lastNewline >= 0 ? offset - lastNewline - 1 : offset;
  return new vscode.Position(line, character);
}

function extractValuesPathsFromText(
  text: string
): { path: string; range: vscode.Range }[] {
  const results: { path: string; range: vscode.Range }[] = [];
  let match: RegExpExecArray | null;
  VALUES_PATH_REGEX.lastIndex = 0;
  while ((match = VALUES_PATH_REGEX.exec(text)) !== null) {
    const startPos = offsetToPosition(text, match.index);
    const endPos = offsetToPosition(text, match.index + match[0].length);
    results.push({
      path: match[1],
      range: new vscode.Range(startPos, endPos),
    });
  }
  return results;
}

function isExcluded(pathStr: string, excludePrefixes: string[]): boolean {
  return excludePrefixes.some(
    (p) => pathStr === p || pathStr.startsWith(p + '.')
  );
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      typeof srcVal === 'object' &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === 'object' &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function runDiagnosticsForFolder(
  folder: vscode.WorkspaceFolder,
  collection: vscode.DiagnosticCollection,
  config: {
    helmfilePath: string;
    chartPath?: string;
    baseValuesFile: string;
    overridesDir: string;
    environments?: string[];
    valuesBasePath?: string;
    valuesFilePattern?: string;
    secretsFilePath?: string;
    excludeOrphanPrefixes: string[];
  }
): void {
  const layout = detectLayout(folder, {
    helmfilePath: config.helmfilePath,
    chartPath: config.chartPath,
    baseValuesFile: config.baseValuesFile,
    overridesDir: config.overridesDir,
    environments: config.environments,
    valuesBasePath: config.valuesBasePath,
    valuesFilePattern: config.valuesFilePattern,
  });
  if (!layout) return;

  const envs =
    layout.layout === 'helmfile' ||
    layout.layout === 'override-folder' ||
    layout.layout === 'custom'
      ? layout.environments
      : ['default'];

  const rootPath = layout.rootPath;
  const chartPath = layout.chartPath;
  const chartRoot = path.join(rootPath, chartPath);
  const templatesDir = path.join(chartRoot, 'templates');
  const baseValuesPath = path.join(chartRoot, config.baseValuesFile);

  if (!fs.existsSync(templatesDir) || !fs.statSync(templatesDir).isDirectory()) {
    return;
  }

  // Collect all template files
  const templateFiles: string[] = [];
  function walkTemplates(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'charts') {
          walkTemplates(fullPath);
        } else if (
          entry.name.endsWith('.yaml') ||
          entry.name.endsWith('.yml') ||
          entry.name.endsWith('.tpl')
        ) {
          templateFiles.push(fullPath);
        }
      }
    } catch {
      // ignore
    }
  }
  walkTemplates(templatesDir);

  // Direction 1: Unresolved refs - paths in templates that exist in no values
  const allReferencedPaths = new Set<string>();
  const diagnosticsByUri = new Map<string, vscode.Diagnostic[]>();

  for (const filePath of templateFiles) {
    const uri = vscode.Uri.file(filePath);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const paths = extractValuesPathsFromText(content);
    const diags: vscode.Diagnostic[] = [];

    for (const { path: pathStr, range } of paths) {
      allReferencedPaths.add(pathStr);
      if (isExcluded(pathStr, config.excludeOrphanPrefixes)) continue;

      let resolvedInAnyEnv = false;
      for (const env of envs) {
        let resolved: { values: Record<string, unknown> };
        if (layout.layout === 'helmfile') {
          const ctx: ValuesResolverContext = {
            workspaceRoot: rootPath,
            chartPath,
            baseValuesFile: config.baseValuesFile,
            valueFileTemplates: layout.valueFileTemplates,
            secretsFilePath: config.secretsFilePath,
          };
          resolved = getResolvedValues(ctx, env);
        } else if (layout.layout === 'override-folder') {
          resolved = getResolvedValuesOverrideFolder(
            rootPath,
            chartPath,
            config.baseValuesFile,
            config.overridesDir,
            env
          );
        } else if (layout.layout === 'custom') {
          resolved = getResolvedValuesCustom(
            rootPath,
            chartPath,
            config.baseValuesFile,
            layout.valuesBasePath,
            layout.valuesFilePattern,
            env
          );
        } else {
          const ctx: ValuesResolverContext = {
            workspaceRoot: rootPath,
            chartPath,
            baseValuesFile: config.baseValuesFile,
            valueFileTemplates: [],
          };
          resolved = getResolvedValues(ctx, env);
        }
        if (getValueAtPath(resolved.values, pathStr) !== undefined) {
          resolvedInAnyEnv = true;
          break;
        }
      }
      if (!resolvedInAnyEnv) {
        diags.push(
          new vscode.Diagnostic(
            range,
            `\`.Values.${pathStr}\` is not defined in any values file`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    }
    if (diags.length > 0) {
      diagnosticsByUri.set(uri.toString(), diags);
    }
  }

  // Direction 2: Unused keys - keys in values that appear in no template
  function deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      const srcVal = source[key];
      const tgtVal = result[key];
      if (
        typeof srcVal === 'object' &&
        srcVal !== null &&
        !Array.isArray(srcVal) &&
        typeof tgtVal === 'object' &&
        tgtVal !== null &&
        !Array.isArray(tgtVal)
      ) {
        result[key] = deepMerge(
          tgtVal as Record<string, unknown>,
          srcVal as Record<string, unknown>
        );
      } else {
        result[key] = srcVal;
      }
    }
    return result;
  }

  let allValuesMerged: Record<string, unknown> = {};
  for (const env of envs) {
    let resolved: { values: Record<string, unknown> };
    if (layout.layout === 'helmfile') {
      const ctx: ValuesResolverContext = {
        workspaceRoot: rootPath,
        chartPath,
        baseValuesFile: config.baseValuesFile,
        valueFileTemplates: layout.valueFileTemplates,
        secretsFilePath: config.secretsFilePath,
      };
      resolved = getResolvedValues(ctx, env);
    } else if (layout.layout === 'override-folder') {
      resolved = getResolvedValuesOverrideFolder(
        rootPath,
        chartPath,
        config.baseValuesFile,
        config.overridesDir,
        env
      );
    } else if (layout.layout === 'custom') {
      resolved = getResolvedValuesCustom(
        rootPath,
        chartPath,
        config.baseValuesFile,
        layout.valuesBasePath,
        layout.valuesFilePattern,
        env
      );
    } else {
      const ctx: ValuesResolverContext = {
        workspaceRoot: rootPath,
        chartPath,
        baseValuesFile: config.baseValuesFile,
        valueFileTemplates: [],
      };
      resolved = getResolvedValues(ctx, env);
    }
    allValuesMerged = deepMerge(allValuesMerged, resolved.values);
  }

  const leafKeys = flattenLeafKeys(allValuesMerged);
  const unusedKeys = leafKeys.filter((key) => {
    if (isExcluded(key, config.excludeOrphanPrefixes)) return false;
    return !Array.from(allReferencedPaths).some(
      (ref) =>
        ref === key ||
        ref.startsWith(key + '.') ||
        key.startsWith(ref + '.')
    );
  });

  if (unusedKeys.length > 0 && fs.existsSync(baseValuesPath)) {
    const uri = vscode.Uri.file(baseValuesPath);
    const diag = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      `Unused value keys (not referenced in templates): ${unusedKeys.slice(0, 10).join(', ')}${unusedKeys.length > 10 ? ` and ${unusedKeys.length - 10} more` : ''}`,
      vscode.DiagnosticSeverity.Hint
    );
    diagnosticsByUri.set(uri.toString(), [diag]);
  }

  // Update collection for this folder's files
  for (const [uriStr, diags] of diagnosticsByUri) {
    collection.set(vscode.Uri.parse(uriStr), diags);
  }
}

export function registerOrphanDiagnostics(
  context: vscode.ExtensionContext
): void {
  const collection = vscode.languages.createDiagnosticCollection('helmValues');
  context.subscriptions.push(collection);

  function refreshAll(): void {
    collection.clear();
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;

    const config = vscode.workspace.getConfiguration('helmValues');
    const enabled = config.get<boolean>('orphanDiagnosticsEnabled', true);
    if (!enabled) return;

    for (const folder of folders) {
      const cfg = vscode.workspace.getConfiguration('helmValues', folder.uri);
      runDiagnosticsForFolder(folder, collection, {
        helmfilePath: cfg.get<string>('helmfilePath') ?? 'helmfile.yaml',
        chartPath: cfg.get<string>('chartPath'),
        baseValuesFile: cfg.get<string>('baseValuesFile') ?? 'values.yaml',
        overridesDir: cfg.get<string>('overridesDir') ?? 'overrides',
        environments: cfg.get<string[]>('environments'),
        valuesBasePath: cfg.get<string>('valuesBasePath') ?? '.',
        valuesFilePattern: cfg.get<string>('valuesFilePattern'),
        secretsFilePath: cfg.get<string>('secretsFilePath'),
        excludeOrphanPrefixes: cfg.get<string[]>('excludeOrphanPrefixes') ?? [],
      });
    }
  }

  refreshAll();

  const isRelevantFile = (doc: vscode.TextDocument) =>
    doc.uri.fsPath.includes(path.sep + 'templates' + path.sep) ||
    doc.fileName.endsWith('values.yaml') ||
    doc.fileName.endsWith('values.yml');

  context.subscriptions.push(
    vscode.commands.registerCommand('helmValues.refreshDiagnostics', refreshAll),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (vscode.workspace.getWorkspaceFolder(doc.uri) && isRelevantFile(doc)) {
        refreshAll();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (vscode.workspace.getWorkspaceFolder(doc.uri) && isRelevantFile(doc)) {
        refreshAll();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('helmValues')) refreshAll();
    })
  );
}
