import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectLayout } from './layout';
import { findTemplateDefinitionLocation, getTemplatesDir } from './templateFinder';
import { findKeyRangeInYaml, getValuesFilePaths } from './valuesResolver';

const VALUES_PATH_REGEX = /\.Values\.([a-zA-Z0-9_.-]+)/g;
const INCLUDE_REGEX =
  /\{\{-?\s*include\s+"([a-zA-Z0-9_.-]+)"\s+[.\$][^}]*-?\}\}|\(\s*include\s+"([a-zA-Z0-9_.-]+)"\s+[.\$][^)]*\)/g;

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

export function registerDefinitionProvider(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { pattern: '**/templates/**/*.yaml' },
    { pattern: '**/templates/**/*.yml' },
    { pattern: '**/templates/**/*.tpl' },
  ];

  const provider: vscode.DefinitionProvider = {
    provideDefinition(
      document: vscode.TextDocument,
      position: vscode.Position
    ): vscode.Definition | vscode.LocationLink[] | null {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) return null;

      // Include "template.name" → go to define
      const templateName = extractIncludeTemplateNameAtPosition(document, position);
      if (templateName) {
        const templatesDir = getTemplatesDir(document.uri.fsPath);
        if (templatesDir) {
          const found = findTemplateDefinitionLocation(templateName, templatesDir);
          if (found) {
            return new vscode.Location(
              vscode.Uri.file(found.filePath),
              new vscode.Range(
                found.range.line,
                found.range.startChar,
                found.range.line,
                found.range.endChar
              )
            );
          }
        }
        return null;
      }

      // .Values.path → go to values file
      const pathStr = extractValuesPathAtPosition(document, position);
      if (!pathStr) return null;

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

      const layoutForPaths =
        layout.layout === 'helmfile'
          ? {
              layout: 'helmfile',
              valueFileTemplates: layout.valueFileTemplates,
              environments: layout.environments,
            }
          : layout.layout === 'override-folder'
            ? {
                layout: 'override-folder',
                environments: layout.environments,
                overridesDir: config.get<string>('overridesDir') ?? 'overrides',
              }
            : layout.layout === 'custom'
              ? {
                  layout: 'custom',
                  environments: layout.environments,
                  valuesBasePath: layout.valuesBasePath,
                  valuesFilePattern: layout.valuesFilePattern,
                }
              : { layout: 'standalone' };

      const valuesFiles = getValuesFilePaths(
        layout.rootPath,
        layout.chartPath,
        config.get<string>('baseValuesFile') ?? 'values.yaml',
        layoutForPaths,
        config.get<string>('secretsFilePath')
      );

      const locations: vscode.Location[] = [];
      for (const filePath of valuesFiles) {
        if (!fs.existsSync(filePath)) continue;
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const range = findKeyRangeInYaml(content, pathStr);
          if (range) {
            locations.push(
              new vscode.Location(
                vscode.Uri.file(filePath),
                new vscode.Range(
                  range.line,
                  range.startChar,
                  range.line,
                  range.endChar
                )
              )
            );
          }
        } catch {
          // Skip
        }
      }
      return locations.length > 0 ? locations : null;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, provider)
  );
}
