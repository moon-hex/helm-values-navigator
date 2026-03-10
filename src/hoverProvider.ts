import * as path from 'path';
import * as vscode from 'vscode';
import { detectLayout, getContainingChart } from './layout';
import { findTemplateDefinition, getTemplatesDir } from './templateFinder';
import {
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
import { cacheKey, getCached, setCached, type CachedHoverData } from './valuesCache';
import {
  evaluateCoalesce,
  evaluateDefault,
  evaluateTernary,
  getFallbackContext,
} from './valuesFallback';

// Supports: {{ .Values.x }}, {{- if .Values.x }}, {{- with .Values.x }}, etc.
const VALUES_PATH_REGEX = /\.Values\.([a-zA-Z0-9_.-]+)/g;

// Supports: {{ include "name" . }}, {{- include "name" . -}}, (include "name" .)
const INCLUDE_REGEX = /\{\{-?\s*include\s+"([a-zA-Z0-9_.-]+)"\s+[.\$][^}]*-?\}\}|\(\s*include\s+"([a-zA-Z0-9_.-]+)"\s+[.\$][^)]*\)/g;

function extractIncludeTemplateNameAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const line = document.lineAt(position.line).text;
  let match: RegExpExecArray | null;
  INCLUDE_REGEX.lastIndex = 0;
  while ((match = INCLUDE_REGEX.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return match[1] ?? match[2];
    }
  }
  return null;
}

function extractValuesPathAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const line = document.lineAt(position.line).text;
  let match: RegExpExecArray | null;
  VALUES_PATH_REGEX.lastIndex = 0;
  while ((match = VALUES_PATH_REGEX.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return match[1];
    }
  }
  return null;
}

function formatValue(val: unknown): string {
  if (val === undefined || val === null) {
    return '⚠ not set';
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  const str = String(val);
  return str.length > 60 ? str.slice(0, 57) + '...' : str;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function registerHoverProvider(context: vscode.ExtensionContext): void {
  const provider: vscode.HoverProvider = {
    provideHover(document, position) {
      // Check for include first
      const templateName = extractIncludeTemplateNameAtPosition(document, position);
      if (templateName) {
        const templatesDir = getTemplatesDir(document.uri.fsPath);
        if (templatesDir) {
          const found = findTemplateDefinition(templateName, templatesDir);
          if (found) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`### Template \`${templateName}\`\n\n`);
            md.appendMarkdown(`*Defined in ${found.file}*\n\n`);
            md.appendCodeblock(found.content, 'helm');
            return new vscode.Hover(md);
          }
        }
      }

      const pathStr = extractValuesPathAtPosition(document, position);
      if (!pathStr) return null;

      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) return null;

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

      const { layout, baseValues, perEnv } = cached;
      const envs =
        layout.layout === 'helmfile' || layout.layout === 'override-folder' || layout.layout === 'custom'
          ? layout.environments
          : ['default'];
      const baseVal = getValueAtPath(baseValues, pathStr);

      const line = document.lineAt(position.line).text;
      const charOffset = line.slice(0, position.character).length;
      const fallbackCtx = getFallbackContext(line, pathStr, charOffset);

      const rows: string[] = [];
      for (const env of envs) {
        const { resolved, overrideOnly } = perEnv.get(env) ?? { resolved: {}, overrideOnly: {} };
        const val = getValueAtPath(resolved, pathStr);
        const formatted = formatValue(val);
        const differs =
          val !== undefined &&
          val !== null &&
          JSON.stringify(val) !== JSON.stringify(baseVal);
        const isInOverride = getValueAtPath(overrideOnly, pathStr) !== undefined;

        let cell: string;
        if (isInOverride && differs) {
          cell = `<span style="color:var(--vscode-editorWarning-foreground)">**${escapeHtml(formatted)}**</span>`;
        } else if (isInOverride && !differs) {
          cell = `<span style="color:var(--vscode-descriptionForeground)">${escapeHtml(formatted)} <em>(= default)</em></span>`;
        } else {
          cell = `<span style="color:var(--vscode-descriptionForeground)">${escapeHtml(formatted)} <em>(default)</em></span>`;
        }

        if (fallbackCtx?.type === 'coalesce') {
          rows.push(`| ${env} | ${cell} | ${escapeHtml(formatValue(evaluateCoalesce(fallbackCtx.args, resolved, getValueAtPath)))} |`);
        } else if (fallbackCtx?.type === 'or') {
          rows.push(`| ${env} | ${cell} | ${escapeHtml(formatValue(evaluateCoalesce(fallbackCtx.args, resolved, getValueAtPath)))} |`);
        } else if (fallbackCtx?.type === 'default') {
          rows.push(`| ${env} | ${cell} | ${escapeHtml(formatValue(evaluateDefault(fallbackCtx.info, resolved, getValueAtPath)))} |`);
        } else if (fallbackCtx?.type === 'ternary') {
          rows.push(`| ${env} | ${cell} | ${escapeHtml(formatValue(evaluateTernary(fallbackCtx.info, resolved, getValueAtPath)))} |`);
        } else {
          rows.push(`| ${env} | ${cell} |`);
        }
      }

      const showEffective = fallbackCtx !== null;
      const tableHeader = showEffective
        ? '| Environment | Value | Effective |\n|---|---|---|'
        : '| Environment | Value |\n|---|---|';
      const table = [tableHeader, ...rows].join('\n');

      const md = new vscode.MarkdownString();
      md.supportHtml = true;
      md.appendMarkdown(`### \`.Values.${pathStr}\`\n\n`);
      if (fallbackCtx?.type === 'coalesce') {
        const chain = fallbackCtx.args
          .map((a) => (a.type === 'values' ? `.Values.${a.path}` : JSON.stringify(a.value)))
          .join(' → ');
        md.appendMarkdown(`*coalesce chain:* \`${chain}\`\n\n`);
      } else if (fallbackCtx?.type === 'or') {
        const chain = fallbackCtx.args
          .map((a) => (a.type === 'values' ? `.Values.${a.path}` : JSON.stringify(a.value)))
          .join(' → ');
        md.appendMarkdown(`*or chain:* \`${chain}\`\n\n`);
      } else if (fallbackCtx?.type === 'default') {
        const defStr =
          fallbackCtx.info.defaultLiteral !== undefined
            ? JSON.stringify(fallbackCtx.info.defaultLiteral)
            : `.Values.${fallbackCtx.info.defaultPath}`;
        md.appendMarkdown(`*default:* \`${escapeHtml(defStr)}\`\n\n`);
      } else if (fallbackCtx?.type === 'ternary') {
        const { thenArg, elseArg, conditionArg } = fallbackCtx.info;
        const thenStr = thenArg.type === 'values' ? `.Values.${thenArg.path}` : JSON.stringify(thenArg.value);
        const elseStr = elseArg.type === 'values' ? `.Values.${elseArg.path}` : JSON.stringify(elseArg.value);
        const condStr = conditionArg.type === 'values' ? `.Values.${conditionArg.path}` : JSON.stringify(conditionArg.value);
        md.appendMarkdown(`*ternary:* \`${thenStr}\` : \`${elseStr}\` when \`${condStr}\`\n\n`);
      }
      md.appendMarkdown(table);

      return new vscode.Hover(md);
    },
  };

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [
        { pattern: '**/templates/**/*.yaml' },
        { pattern: '**/templates/**/*.yml' },
        { pattern: '**/templates/**/*.tpl' },
      ],
      provider
    )
  );
}
