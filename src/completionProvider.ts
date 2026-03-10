import * as path from 'path';
import * as vscode from 'vscode';
import { detectLayout, getContainingChart } from './layout';
import { getTemplatesDir, listTemplateNames } from './templateFinder';
import { cacheKey, getCached, setCached, type CachedHoverData } from './valuesCache';
import {
  flattenLeafKeys,
  getBaseValues,
  getOverrideOnlyValues,
  getOverrideOnlyValuesCustom,
  getOverrideOnlyValuesOverrideFolder,
  getResolvedValues,
  getResolvedValuesCustom,
  getResolvedValuesOverrideFolder,
  ValuesResolverContext,
} from './valuesResolver';

function getValuesPrefixAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): { prefix: string; range: vscode.Range } | null {
  const line = document.lineAt(position.line).text;
  const beforeCursor = line.slice(0, position.character);
  const valuesMatch = beforeCursor.match(/\.Values\.([a-zA-Z0-9_.-]*)$/);
  if (!valuesMatch) return null;
  const prefix = valuesMatch[1];
  const startChar = beforeCursor.length - prefix.length;
  return {
    prefix,
    range: new vscode.Range(position.line, startChar, position.line, position.character),
  };
}

function getIncludePrefixAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): { prefix: string; range: vscode.Range } | null {
  const line = document.lineAt(position.line).text;
  const beforeCursor = line.slice(0, position.character);
  const includeMatch = beforeCursor.match(/include\s+"([a-zA-Z0-9_.-]*)$/);
  if (!includeMatch) return null;
  const prefix = includeMatch[1];
  const startChar = beforeCursor.length - prefix.length;
  return {
    prefix,
    range: new vscode.Range(position.line, startChar, position.line, position.character),
  };
}

export function registerCompletionProvider(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { pattern: '**/templates/**/*.yaml' },
    { pattern: '**/templates/**/*.yml' },
    { pattern: '**/templates/**/*.tpl' },
  ];

  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position
    ): vscode.CompletionItem[] | vscode.CompletionList | null {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) return null;

      // Include "template.name" completion
      const includeCtx = getIncludePrefixAtPosition(document, position);
      if (includeCtx) {
        const templatesDir = getTemplatesDir(document.uri.fsPath);
        if (templatesDir) {
          const names = listTemplateNames(templatesDir);
          const { prefix, range } = includeCtx;
          const items = names
            .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()))
            .map((name) => {
              const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
              item.range = range;
              item.detail = 'template';
              return item;
            });
          return items;
        }
        return null;
      }

      // .Values.path completion
      const valuesCtx = getValuesPrefixAtPosition(document, position);
      if (!valuesCtx) return null;

      const chartDir = getContainingChart(folder, document.uri.fsPath);
      if (!chartDir) return null;

      const config = vscode.workspace.getConfiguration('helmValues', folder.uri);
      const chartPathRel = path.relative(folder.uri.fsPath, chartDir).replace(/\\/g, '/');
      const key = cacheKey(folder.uri.toString(), chartPathRel);
      let cached: CachedHoverData | null = getCached(key);

      if (!cached) {
        const layout = detectLayout(folder, {
          helmfilePath: config.get<string>('helmfilePath') ?? 'helmfile.yaml',
          chartPath: config.get<string>('chartPath'),
          baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
          overridesDir: config.get<string>('overridesDir') ?? 'overrides',
          environments: config.get<string[]>('environments'),
          valuesBasePath: config.get<string>('valuesBasePath') ?? '.',
          valuesFilePattern: config.get<string>('valuesFilePattern'),
        },
        chartDir
        );
        if (!layout) return null;

        const envs =
          layout.layout === 'helmfile' || layout.layout === 'override-folder' || layout.layout === 'custom'
            ? layout.environments
            : ['default'];

        const baseValues = getBaseValues(
          layout.rootPath,
          layout.chartPath,
          config.get<string>('baseValuesFile') ?? 'values.yaml'
        );
        const perEnv = new Map<string, { resolved: Record<string, unknown>; overrideOnly: Record<string, unknown> }>();
        for (const env of envs) {
          let resolved;
          let overrideOnly: Record<string, unknown> = {};
          if (layout.layout === 'helmfile') {
            const ctx: ValuesResolverContext = {
              workspaceRoot: layout.rootPath,
              chartPath: layout.chartPath,
              baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
              valueFileTemplates: layout.valueFileTemplates,
              secretsFilePath: config.get<string>('secretsFilePath'),
            };
            resolved = getResolvedValues(ctx, env);
            overrideOnly = getOverrideOnlyValues(ctx, env);
          } else if (layout.layout === 'override-folder') {
            resolved = getResolvedValuesOverrideFolder(
              layout.rootPath,
              layout.chartPath,
              config.get<string>('baseValuesFile') ?? 'values.yaml',
              config.get<string>('overridesDir') ?? 'overrides',
              env
            );
            overrideOnly = getOverrideOnlyValuesOverrideFolder(
              layout.rootPath,
              layout.chartPath,
              config.get<string>('overridesDir') ?? 'overrides',
              env
            );
          } else if (layout.layout === 'custom') {
            resolved = getResolvedValuesCustom(
              layout.rootPath,
              layout.chartPath,
              config.get<string>('baseValuesFile') ?? 'values.yaml',
              layout.valuesBasePath,
              layout.valuesFilePattern,
              env
            );
            overrideOnly = getOverrideOnlyValuesCustom(
              layout.rootPath,
              layout.valuesBasePath,
              layout.valuesFilePattern,
              env
            );
          } else {
            const ctx: ValuesResolverContext = {
              workspaceRoot: layout.rootPath,
              chartPath: layout.chartPath,
              baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
              valueFileTemplates: [],
            };
            resolved = getResolvedValues(ctx, env);
          }
          perEnv.set(env, { resolved: resolved.values, overrideOnly });
        }
        cached = { layout, baseValues, perEnv };
        setCached(key, cached);
      }

      const { baseValues, perEnv } = cached;
      const firstEnv = perEnv.keys().next().value;
      const merged = firstEnv ? (perEnv.get(firstEnv)?.resolved ?? baseValues) : baseValues;

      const allPaths = flattenLeafKeys(merged as Record<string, unknown>);
      const { prefix, range } = valuesCtx;

      const prefixNorm = prefix.toLowerCase();
      const prefixWithDot = prefixNorm.endsWith('.') ? prefixNorm : prefixNorm + '.';
      const items: vscode.CompletionItem[] = [];
      const seen = new Set<string>();

      for (const p of allPaths) {
        const pLower = p.toLowerCase();
        const match =
          prefixNorm === ''
            ? true
            : pLower.startsWith(prefixWithDot) || (!prefixNorm.endsWith('.') && pLower.startsWith(prefixNorm));
        if (!match) continue;

        let label: string;
        let insertText: string;
        if (prefixNorm === '') {
          label = p.includes('.') ? p.split('.')[0] : p;
          insertText = p;
        } else if (prefixNorm.endsWith('.')) {
          const remainder = p.slice(prefix.length);
          label = remainder.includes('.') ? remainder.split('.')[0] : remainder;
          insertText = prefix + (remainder.includes('.') ? label + '.' : remainder);
        } else {
          label = p;
          insertText = p;
        }
        if (seen.has(insertText)) continue;
        seen.add(insertText);

        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Field);
        item.range = range;
        item.insertText = insertText;
        item.detail = 'values';
        items.push(item);
      }

      return items;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, provider, '.', '"')
  );
}
