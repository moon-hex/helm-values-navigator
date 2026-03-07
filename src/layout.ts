import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseHelmfile } from './valuesResolver';

export type LayoutType = 'helmfile' | 'override-folder' | 'standalone';

export interface ChartInfo {
  rootPath: string;
  rootUri: vscode.Uri;
  layout: LayoutType;
  workspaceFolder: vscode.WorkspaceFolder;
}

export interface HelmfileInfo extends ChartInfo {
  layout: 'helmfile';
  helmfilePath: string;
  chartPath: string;
  environments: string[];
  valueFileTemplates: string[]; // e.g. ["./values/values-{{ .Environment.Name }}.yml", "./secrets.yml"]
}

export interface OverrideFolderInfo extends ChartInfo {
  layout: 'override-folder';
  chartPath: string;
  environments: string[];
}

export interface StandaloneInfo extends ChartInfo {
  layout: 'standalone';
  chartPath: string;
}

export type ResolvedLayout = HelmfileInfo | OverrideFolderInfo | StandaloneInfo;

function findChartYamlPaths(folder: vscode.WorkspaceFolder): string[] {
  const results: string[] = [];
  const rootPath = folder.uri.fsPath;

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'charts') {
            continue; // Skip deps and downloaded charts
          }
          walk(fullPath);
        } else if (entry.name === 'Chart.yaml') {
          results.push(path.dirname(fullPath));
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(rootPath);
  return results;
}

export function detectLayout(
  folder: vscode.WorkspaceFolder,
  config: {
    helmfilePath: string;
    chartPath?: string;
    baseValuesFile: string;
    overridesDir: string;
  }
): ResolvedLayout | null {
  const rootPath = folder.uri.fsPath;
  const rootUri = folder.uri;

  const helmfileFullPath = path.join(rootPath, config.helmfilePath);
  const hasHelmfile = fs.existsSync(helmfileFullPath);

  const chartDirs = findChartYamlPaths(folder);
  if (chartDirs.length === 0) {
    return null;
  }

  let chartPath: string;
  if (config.chartPath) {
    chartPath = path.join(rootPath, config.chartPath);
    if (!fs.existsSync(path.join(chartPath, 'Chart.yaml'))) {
      chartPath = chartDirs[0]; // Fallback
    }
  } else {
    chartPath = chartDirs[0];
  }

  if (hasHelmfile) {
    const helmfile = parseHelmfile(helmfileFullPath);
    if (helmfile) {
      const helmfileChartPath = path.join(
        path.dirname(helmfileFullPath),
        helmfile.chartPath
      );
      const chartPathResolved = fs.existsSync(path.join(helmfileChartPath, 'Chart.yaml'))
        ? helmfileChartPath
        : chartPath;
      const chartPathRel = path.relative(rootPath, chartPathResolved).replace(/\\/g, '/');
      return {
        layout: 'helmfile',
        rootPath,
        rootUri,
        workspaceFolder: folder,
        helmfilePath: helmfileFullPath,
        chartPath: chartPathRel,
        environments: helmfile.environments,
        valueFileTemplates: helmfile.valueFileTemplates,
      };
    }
  }

  // Override-folder: helm/*/overrides/*.yaml
  const overridesPath = path.join(chartPath, config.overridesDir);
  if (fs.existsSync(overridesPath) && fs.statSync(overridesPath).isDirectory()) {
    const overrideFiles = fs.readdirSync(overridesPath);
    const envs = overrideFiles
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => f.replace(/\.(yaml|yml)$/, ''));

    if (envs.length > 0) {
      const chartPathRel = path.relative(rootPath, chartPath).replace(/\\/g, '/');
      return {
        layout: 'override-folder',
        rootPath,
        rootUri,
        workspaceFolder: folder,
        chartPath: chartPathRel,
        environments: envs,
      };
    }
  }

  const chartPathRel = path.relative(rootPath, chartPath).replace(/\\/g, '/');
  return {
    layout: 'standalone',
    rootPath,
    rootUri,
    workspaceFolder: folder,
    chartPath: chartPathRel,
  };
}

