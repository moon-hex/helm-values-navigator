import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { detectLayout } from './layout';
import { getValuesPathsFromTgz } from './subchartTgz';
import { getCachedDiagnostics, setCachedDiagnostics } from './valuesCache';
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

/** Diagnostic code for missing subchart dependencies - enables Quick Fix. */
export const MISSING_SUBCHART_DEPS_CODE = 'helmValues.missingSubchartDeps';

/** Extract .Values path from orphan diagnostic message. */
function getPathFromOrphanDiagnostic(message: string): string | null {
  const m = message.match(/\.Values\.([a-zA-Z0-9_.-]+)/);
  return m ? m[1] : null;
}

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
  return excludePrefixes.some((p) => {
    if (p.includes('*')) {
      const re = new RegExp(
        '^' + p.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '(\\.|$)'
      );
      return re.test(pathStr);
    }
    return pathStr === p || pathStr.startsWith(p + '.');
  });
}

/** Find the line and character range for a dotted key path in YAML content (block style, object keys only). */
function findKeyRangeInYaml(
  content: string,
  dottedPath: string
): { line: number; startChar: number; endChar: number } | null {
  const lines = content.split('\n');
  const pathParts: string[] = [];
  const indentStack: number[] = [-1];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTrimmed = line.trimStart();
    if (lineTrimmed === '' || lineTrimmed.startsWith('#')) continue;

    const indent = line.length - lineTrimmed.length;
    const keyMatch = lineTrimmed.match(/^([a-zA-Z0-9_.-]+)\s*:/);
    if (!keyMatch) continue;

    const key = keyMatch[1];
    const keyStart = line.indexOf(key);
    const keyEnd = keyStart + key.length;

    while (indentStack.length > 1 && indent <= indentStack[indentStack.length - 1]) {
      indentStack.pop();
      pathParts.pop();
    }

    pathParts.push(key);
    indentStack.push(indent);

    const currentPath = pathParts.join('.');
    if (currentPath === dottedPath) {
      return { line: i, startChar: keyStart, endChar: keyEnd };
    }

    if (!dottedPath.startsWith(currentPath + '.')) {
      pathParts.pop();
      indentStack.pop();
    }
  }
  return null;
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

type ChartDep = { name: string; chartDir?: string; tgzPath?: string };

/** Parse Chart.yaml and return dependency names with their chart dirs or tgz paths. */
function getChartDependencies(
  chartRoot: string
): { found: ChartDep[]; expectedNames: string[] } {
  const chartYamlPath = path.join(chartRoot, 'Chart.yaml');
  if (!fs.existsSync(chartYamlPath)) return { found: [], expectedNames: [] };

  let doc: Record<string, unknown> | null;
  try {
    const content = fs.readFileSync(chartYamlPath, 'utf8');
    doc = yaml.load(content) as Record<string, unknown> | null;
  } catch {
    return { found: [], expectedNames: [] };
  }
  if (!doc || typeof doc !== 'object') return { found: [], expectedNames: [] };

  const deps = doc.dependencies as Array<{ name?: string }> | undefined;
  if (!Array.isArray(deps)) return { found: [], expectedNames: [] };

  const expectedNames = deps
    .map((d) => d?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);

  const chartsDir = path.join(chartRoot, 'charts');
  if (!fs.existsSync(chartsDir) || !fs.statSync(chartsDir).isDirectory()) {
    return { found: [], expectedNames };
  }

  const found: ChartDep[] = [];
  for (const dep of deps) {
    const name = dep?.name;
    if (typeof name !== 'string' || !name) continue;

    const exactPath = path.join(chartsDir, name);
    if (fs.existsSync(exactPath) && fs.statSync(exactPath).isDirectory()) {
      if (fs.existsSync(path.join(exactPath, 'Chart.yaml'))) {
        found.push({ name, chartDir: exactPath });
      }
      continue;
    }

    try {
      const entries = fs.readdirSync(chartsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && (entry.name === name || entry.name.startsWith(name + '-'))) {
          const chartDir = path.join(chartsDir, entry.name);
          if (fs.existsSync(path.join(chartDir, 'Chart.yaml'))) {
            found.push({ name, chartDir });
            break;
          }
        }
        if (entry.isFile() && entry.name.endsWith('.tgz') && (entry.name === `${name}.tgz` || entry.name.startsWith(name + '-'))) {
          found.push({ name, tgzPath: path.join(chartsDir, entry.name) });
          break;
        }
      }
    } catch {
      // ignore
    }
  }
  return { found, expectedNames };
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
): Map<string, vscode.Diagnostic[]> | undefined {
  const layout = detectLayout(folder, {
    helmfilePath: config.helmfilePath,
    chartPath: config.chartPath,
    baseValuesFile: config.baseValuesFile,
    overridesDir: config.overridesDir,
    environments: config.environments,
    valuesBasePath: config.valuesBasePath,
    valuesFilePattern: config.valuesFilePattern,
  });
  if (!layout) return undefined;

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
    return undefined;
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

  const { found: dependencies, expectedNames } = getChartDependencies(chartRoot);

  // Pre-compute resolved values once per env (avoids O(paths × envs) resolver calls)
  const resolvedByEnv = new Map<string, Record<string, unknown>>();
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
    resolvedByEnv.set(env, resolved.values);
  }

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

      const resolvedInAnyEnv = Array.from(resolvedByEnv.values()).some(
        (values) => getValueAtPath(values, pathStr) !== undefined
      );
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

  // Warn when Chart.yaml lists dependencies but they're not in charts/
  if (expectedNames.length > 0 && dependencies.length < expectedNames.length) {
    const chartYamlUri = vscode.Uri.file(path.join(chartRoot, 'Chart.yaml'));
    const diag = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 80),
      "Subchart dependencies not found in charts/. Run 'helm dependency update' in the chart directory so orphan diagnostics can check subchart template usage.",
      vscode.DiagnosticSeverity.Information
    );
    diag.code = MISSING_SUBCHART_DEPS_CODE;
    const existing = diagnosticsByUri.get(chartYamlUri.toString()) ?? [];
    diagnosticsByUri.set(chartYamlUri.toString(), [...existing, diag]);
  }

  // Add paths from dependency (subchart) templates - parent values under dep name are used there
  for (const dep of dependencies) {
    const { name } = dep;
    if (dep.tgzPath) {
      const paths = getValuesPathsFromTgz(dep.tgzPath, name);
      for (const p of paths) allReferencedPaths.add(p);
      continue;
    }
    const chartDir = dep.chartDir;
    if (!chartDir) continue;
    const depTemplatesDir = path.join(chartDir, 'templates');
    if (!fs.existsSync(depTemplatesDir) || !fs.statSync(depTemplatesDir).isDirectory()) continue;
    const depFiles: string[] = [];
    function walkDep(dir: string): void {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name !== 'charts') walkDep(fullPath);
          else if (/\.(yaml|yml|tpl)$/.test(entry.name)) depFiles.push(fullPath);
        }
      } catch {
        // ignore
      }
    }
    walkDep(depTemplatesDir);
    for (const fp of depFiles) {
      try {
        const c = fs.readFileSync(fp, 'utf8');
        const paths = extractValuesPathsFromText(c);
        for (const { path: pathStr } of paths) allReferencedPaths.add(`${name}.${pathStr}`);
      } catch {
        // ignore
      }
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
    const values = resolvedByEnv.get(env);
    if (values) allValuesMerged = deepMerge(allValuesMerged, values);
  }

  const leafKeys = flattenLeafKeys(allValuesMerged);
  const unusedKeysSet = new Set(
    leafKeys.filter((key) => {
      if (isExcluded(key, config.excludeOrphanPrefixes)) return false;
      return !Array.from(allReferencedPaths).some(
        (ref) =>
          ref === key ||
          ref.startsWith(key + '.') ||
          key.startsWith(ref + '.')
      );
    })
  );

  // Build list of values files with their content and keys (per layout)
  type ValuesFileEntry = { filePath: string; content: string; keys: string[] };
  const valuesFiles: ValuesFileEntry[] = [];
  const resolveTemplate = (t: string, env: string) =>
    t.replace(/\{\{\s*\.Environment\.Name\s*\}\}/g, env);
  const isSecretsTemplate = (t: string) =>
    /secrets\.(yaml|yml)$/i.test(resolveTemplate(t, 'x'));

  // Base values
  if (fs.existsSync(baseValuesPath)) {
    const content = fs.readFileSync(baseValuesPath, 'utf8');
    const parsed = yaml.load(content) as Record<string, unknown> | null;
    const obj = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    valuesFiles.push({
      filePath: baseValuesPath,
      content,
      keys: flattenLeafKeys(obj),
    });
  }

  if (layout.layout === 'helmfile') {
    for (const env of envs) {
      for (const template of layout.valueFileTemplates) {
        let filePath = path.join(rootPath, resolveTemplate(template, env));
        if (config.secretsFilePath && isSecretsTemplate(template)) {
          filePath = path.isAbsolute(config.secretsFilePath)
            ? config.secretsFilePath
            : path.join(rootPath, config.secretsFilePath);
        }
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.load(content) as Record<string, unknown> | null;
        const obj = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
        valuesFiles.push({ filePath, content, keys: flattenLeafKeys(obj) });
      }
    }
  } else if (layout.layout === 'override-folder') {
    const overridesDir = path.join(chartRoot, config.overridesDir);
    for (const env of envs) {
      const yamlPath = path.join(overridesDir, `${env}.yaml`);
      const ymlPath = path.join(overridesDir, `${env}.yml`);
      const filePath = fs.existsSync(yamlPath) ? yamlPath : fs.existsSync(ymlPath) ? ymlPath : null;
      if (!filePath) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = yaml.load(content) as Record<string, unknown> | null;
      const obj = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
      valuesFiles.push({ filePath, content, keys: flattenLeafKeys(obj) });
    }
  } else if (layout.layout === 'custom') {
    for (const env of envs) {
      const filePath = path.join(
        rootPath,
        config.valuesBasePath ?? '.',
        layout.valuesFilePattern.replace(/{env}/g, env)
      );
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = yaml.load(content) as Record<string, unknown> | null;
      const obj = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
      valuesFiles.push({ filePath, content, keys: flattenLeafKeys(obj) });
    }
  }

  for (const { filePath, content, keys } of valuesFiles) {
    const unusedInFile = keys.filter((k) => unusedKeysSet.has(k));
    if (unusedInFile.length === 0) continue;
    const uri = vscode.Uri.file(filePath);
    const diags: vscode.Diagnostic[] = [];
    for (const key of unusedInFile) {
      const range = findKeyRangeInYaml(content, key);
      if (range) {
        const lines = content.split(/\r?\n/);
        const lineText = lines[range.line] ?? '';
        const endChar = lineText.length;
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(range.line, 0, range.line, endChar),
            `\`.Values.${key}\` is not referenced in any template`,
            vscode.DiagnosticSeverity.Information
          )
        );
      }
    }
    if (diags.length > 0) {
      const existing = diagnosticsByUri.get(uri.toString()) ?? [];
      diagnosticsByUri.set(uri.toString(), [...existing, ...diags]);
    }
  }

  // Update collection for this folder's files
  for (const [uriStr, diags] of diagnosticsByUri) {
    collection.set(vscode.Uri.parse(uriStr), diags);
  }
  return diagnosticsByUri;
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
      const folderKey = folder.uri.toString();
      const cachedDiags = getCachedDiagnostics(folderKey);
      if (cachedDiags) {
        for (const [uriStr, diags] of cachedDiags) {
          collection.set(vscode.Uri.parse(uriStr), diags);
        }
        continue;
      }
      const cfg = vscode.workspace.getConfiguration('helmValues', folder.uri);
      const diagsByUri = runDiagnosticsForFolder(folder, collection, {
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
      if (diagsByUri) setCachedDiagnostics(folderKey, diagsByUri);
    }
  }

  refreshAll();

  let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
  const DEBOUNCE_MS = 400;
  function debouncedRefresh(): void {
    if (refreshTimeout) clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(() => {
      refreshTimeout = undefined;
      refreshAll();
    }, DEBOUNCE_MS);
  }

  const isRelevantFile = (doc: vscode.TextDocument) =>
    doc.uri.fsPath.includes(path.sep + 'templates' + path.sep) ||
    doc.fileName.endsWith('values.yaml') ||
    doc.fileName.endsWith('values.yml') ||
    doc.fileName.endsWith('Chart.yaml');

  context.subscriptions.push(
    vscode.commands.registerCommand('helmValues.refreshDiagnostics', refreshAll),
    vscode.commands.registerCommand(
      'helmValues.updateDependencies',
      (chartRoot?: string) => {
        const dir = chartRoot ?? (() => {
          const doc = vscode.window.activeTextEditor?.document;
          if (doc?.uri.fsPath.endsWith('Chart.yaml') || doc?.uri.fsPath.endsWith(path.sep + 'Chart.yaml')) {
            return path.dirname(doc.uri.fsPath);
          }
          return undefined;
        })();
        if (!dir) {
          vscode.window.showErrorMessage('No chart directory found. Open Chart.yaml or run from a Helm chart.');
          return;
        }
        const term = vscode.window.createTerminal({ cwd: dir, name: 'Helm' });
        term.sendText('helm dependency update');
        term.show();
        vscode.window.showInformationMessage(
          'Running helm dependency update. Run "Helm: Refresh Diagnostics" after it completes.'
        );
      }
    ),
    vscode.commands.registerCommand(
      'helmValues.addToExcludeList',
      async (
        prefix: string,
        scope?: vscode.ConfigurationScope,
        promptForEdit?: boolean
      ) => {
        if (promptForEdit) {
          const edited = await vscode.window.showInputBox({
            title: 'Add to orphan exclude list',
            value: prefix,
            prompt: 'Edit the path prefix. Use * for one segment (e.g. secrets.*).',
            validateInput: (v) =>
              v.trim() ? null : 'Enter a valid path prefix',
          });
          if (edited === undefined) return;
          prefix = edited.trim();
        }
        const config = vscode.workspace.getConfiguration('helmValues', scope);
        const current = config.get<string[]>('excludeOrphanPrefixes') ?? [];
        if (current.includes(prefix)) {
          vscode.window.showInformationMessage(`'${prefix}' is already in the exclude list.`);
          return;
        }
        const next = [...current, prefix].sort();
        await config.update(
          'excludeOrphanPrefixes',
          next,
          scope ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace
        );
        vscode.window.showInformationMessage(`Added '${prefix}' to helmValues.excludeOrphanPrefixes`);
      }
    ),
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**/Chart.yaml' },
      {
        provideCodeActions(document, _range, context) {
          const hasMissingDeps = context.diagnostics.some(
            (d) => d.code === MISSING_SUBCHART_DEPS_CODE || (typeof d.code === 'object' && d.code?.value === MISSING_SUBCHART_DEPS_CODE)
          );
          if (!hasMissingDeps) return [];
          const chartRoot = path.dirname(document.uri.fsPath);
          const action = new vscode.CodeAction(
            "Run 'helm dependency update'",
            vscode.CodeActionKind.QuickFix
          );
          action.command = {
            command: 'helmValues.updateDependencies',
            title: "Run helm dependency update",
            arguments: [chartRoot],
          };
          return [action];
        },
      }
    ),
    vscode.languages.registerCodeActionsProvider(
      [
        { pattern: '**/templates/**/*.yaml' },
        { pattern: '**/templates/**/*.yml' },
        { pattern: '**/templates/**/*.tpl' },
        { pattern: '**/values.yaml' },
        { pattern: '**/values.yml' },
        { pattern: '**/overrides/*.yaml' },
        { pattern: '**/overrides/*.yml' },
      ],
      {
        provideCodeActions(document, _range, context) {
          const folder = vscode.workspace.getWorkspaceFolder(document.uri);
          if (!folder) return [];
          const actions: vscode.CodeAction[] = [];
          const seen = new Set<string>();
          for (const d of context.diagnostics) {
            const pathStr = getPathFromOrphanDiagnostic(d.message);
            if (!pathStr) continue;
            const prefix = pathStr.split('.')[0];
            if (!seen.has(prefix)) {
              seen.add(prefix);
              const addAction = new vscode.CodeAction(
                `Add '${prefix}' to orphan exclude list`,
                vscode.CodeActionKind.QuickFix
              );
              addAction.command = {
                command: 'helmValues.addToExcludeList',
                title: 'Add to exclude list',
                arguments: [prefix, folder.uri],
              };
              actions.push(addAction);
              const editAction = new vscode.CodeAction(
                `Add to exclude list (edit...)`,
                vscode.CodeActionKind.QuickFix
              );
              editAction.command = {
                command: 'helmValues.addToExcludeList',
                title: 'Add to exclude list',
                arguments: [prefix, folder.uri, true],
              };
              actions.push(editAction);
            }
            if (prefix !== pathStr && !seen.has(pathStr)) {
              seen.add(pathStr);
              const a = new vscode.CodeAction(
                `Add '${pathStr}' to orphan exclude list`,
                vscode.CodeActionKind.QuickFix
              );
              a.command = {
                command: 'helmValues.addToExcludeList',
                title: 'Add to exclude list',
                arguments: [pathStr, folder.uri],
              };
              actions.push(a);
            }
          }
          return actions;
        },
      }
    ),
    // Skip refresh on open - only on save. Reduces perceived lag when switching files.
    // vscode.workspace.onDidOpenTextDocument((doc) => { ... }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (vscode.workspace.getWorkspaceFolder(doc.uri) && isRelevantFile(doc)) {
        debouncedRefresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('helmValues')) refreshAll();
    })
  );
}
