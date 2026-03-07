import * as vscode from 'vscode';
import { detectLayout } from './layout';
import { findTemplateDefinition, getTemplatesDir } from './templateFinder';
import {
  getBaseValues,
  getResolvedValues,
  getResolvedValuesOverrideFolder,
  getValueAtPath,
  ValuesResolverContext,
} from './valuesResolver';

// Supports: {{ .Values.x }}, {{.Values.x}}, {{- .Values.x -}}, {{  .Values.x  }}
const VALUES_PATH_REGEX = /\{\{-?\s*\.Values\.([a-zA-Z0-9_.-]+)\s*-?\}\}/g;

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

      const path = extractValuesPathAtPosition(document, position);
      if (!path) return null;

      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) return null;

      const config = vscode.workspace.getConfiguration('helmValues', folder.uri);
      const layout = detectLayout(folder, {
        helmfilePath: config.get<string>('helmfilePath') ?? 'helmfile.yaml',
        chartPath: config.get<string>('chartPath'),
        baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
        overridesDir: config.get<string>('overridesDir') ?? 'overrides',
      });

      if (!layout) return null;

      const envs =
        layout.layout === 'helmfile' || layout.layout === 'override-folder'
          ? layout.environments
          : ['default'];

      const baseValues = getBaseValues(
        layout.rootPath,
        layout.chartPath,
        config.get<string>('baseValuesFile') ?? 'values.yaml'
      );
      const baseVal = getValueAtPath(baseValues, path);

      const rows: string[] = [];
      for (const env of envs) {
        let resolved;
        if (layout.layout === 'helmfile') {
          const ctx: ValuesResolverContext = {
            workspaceRoot: layout.rootPath,
            chartPath: layout.chartPath,
            baseValuesFile: config.get<string>('baseValuesFile') ?? 'values.yaml',
            valueFileTemplates: layout.valueFileTemplates,
            secretsFilePath: config.get<string>('secretsFilePath'),
          };
          resolved = getResolvedValues(ctx, env);
        } else if (layout.layout === 'override-folder') {
          resolved = getResolvedValuesOverrideFolder(
            layout.rootPath,
            layout.chartPath,
            config.get<string>('baseValuesFile') ?? 'values.yaml',
            config.get<string>('overridesDir') ?? 'overrides',
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

        const val = getValueAtPath(resolved.values, path);
        const formatted = formatValue(val);
        const differs =
          val !== undefined &&
          val !== null &&
          JSON.stringify(val) !== JSON.stringify(baseVal);
        const cell = differs ? `**${formatted}**` : formatted;
        rows.push(`| ${env} | ${cell} |`);
      }

      const table = [
        '| Environment | Value |',
        '|---|---|',
        ...rows,
      ].join('\n');

      const md = new vscode.MarkdownString();
      md.appendMarkdown(`### \`.Values.${path}\`\n\n`);
      md.appendMarkdown(table);
      md.isTrusted = true;

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
