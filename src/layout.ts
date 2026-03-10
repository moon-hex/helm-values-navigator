import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseHelmfile } from './valuesResolver';

export type LayoutType = 'helmfile' | 'override-folder' | 'standalone' | 'custom';

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

export interface CustomInfo extends ChartInfo {
  layout: 'custom';
  chartPath: string;
  environments: string[];
  valuesBasePath: string;
  valuesFilePattern: string;
}

export type ResolvedLayout = HelmfileInfo | OverrideFolderInfo | StandaloneInfo | CustomInfo;

/** Find all chart dirs (containing Chart.yaml) in the workspace folder. */
export function findChartYamlPaths(folder: vscode.WorkspaceFolder): string[] {
  const results: string[] = [];
  const rootPath = folder.uri.fsPath;

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          // Skip charts/ only when it's a chart's deps folder (parent has Chart.yaml)
          if (entry.name === 'charts' && fs.existsSync(path.join(dir, 'Chart.yaml'))) continue;
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

/** Find the chart dir that contains docPath (longest match if nested). Returns null if doc is not in any chart. */
export function getContainingChart(
  folder: vscode.WorkspaceFolder,
  docPath: string
): string | null {
  const chartDirs = findChartYamlPaths(folder);
  const docPathNorm = path.normalize(docPath);
  const sep = path.sep;

  let best: string | null = null;
  let bestLen = 0;
  for (const chartDir of chartDirs) {
    const chartDirNorm = path.normalize(chartDir);
    const prefix = chartDirNorm.endsWith(sep) ? chartDirNorm : chartDirNorm + sep;
    if (docPathNorm.startsWith(prefix) && prefix.length > bestLen) {
      best = chartDir;
      bestLen = prefix.length;
    }
  }
  return best;
}

export function detectLayout(
  folder: vscode.WorkspaceFolder,
  config: {
    helmfilePath: string;
    chartPath?: string;
    baseValuesFile: string;
    overridesDir: string;
    environments?: string[];
    valuesBasePath?: string;
    valuesFilePattern?: string;
  },
  /** When provided, detect layout for this specific chart. Used for multi-chart workspaces. */
  forChartPath?: string
): ResolvedLayout | null {
  const rootPath = folder.uri.fsPath;
  const rootUri = folder.uri;

  // 1. Custom with explicit chartPath - no workspace walk (skip when forChartPath targets a different chart)
  if (!forChartPath && config.environments?.length && config.valuesFilePattern && config.chartPath) {
    const chartPathFull = path.join(rootPath, config.chartPath);
    if (fs.existsSync(path.join(chartPathFull, 'Chart.yaml'))) {
      const chartPathRel = path.relative(rootPath, chartPathFull).replace(/\\/g, '/');
      return {
        layout: 'custom',
        rootPath,
        rootUri,
        workspaceFolder: folder,
        chartPath: chartPathRel,
        environments: config.environments,
        valuesBasePath: config.valuesBasePath ?? '.',
        valuesFilePattern: config.valuesFilePattern,
      };
    }
  }

  // 2. Helmfile - no workspace walk (chart path from helmfile)
  const helmfileFullPath = path.join(rootPath, config.helmfilePath);
  if (fs.existsSync(helmfileFullPath)) {
    const helmfile = parseHelmfile(helmfileFullPath);
    if (helmfile) {
      const helmfileChartPath = path.join(
        path.dirname(helmfileFullPath),
        helmfile.chartPath
      );
      const helmfileChartPathNorm = path.normalize(helmfileChartPath);
      const forChartPathNorm = forChartPath ? path.normalize(forChartPath) : null;

      // When forChartPath provided: use helmfile only if it matches
      if (!forChartPathNorm || helmfileChartPathNorm === forChartPathNorm) {
        if (fs.existsSync(path.join(helmfileChartPath, 'Chart.yaml'))) {
          const helmfileChartPathRel = path.relative(rootPath, helmfileChartPath).replace(/\\/g, '/');
          return {
            layout: 'helmfile',
            rootPath,
            rootUri,
            workspaceFolder: folder,
            helmfilePath: helmfileFullPath,
            chartPath: helmfileChartPathRel,
            environments: helmfile.environments,
            valueFileTemplates: helmfile.valueFileTemplates,
          };
        }
      }
    }
  }

  // 3. Remaining layouts: use forChartPath if provided, else find first chart
  let chartPath: string;
  if (forChartPath) {
    chartPath = path.normalize(forChartPath);
    if (!fs.existsSync(path.join(chartPath, 'Chart.yaml'))) return null;
  } else {
    const chartDirs = findChartYamlPaths(folder);
    if (chartDirs.length === 0) return null;

    if (config.chartPath) {
      chartPath = path.join(rootPath, config.chartPath);
      if (!fs.existsSync(path.join(chartPath, 'Chart.yaml'))) {
        chartPath = chartDirs[0];
      }
    } else {
      chartPath = chartDirs[0];
    }
  }
  const chartPathRel = path.relative(rootPath, chartPath).replace(/\\/g, '/');

  // Custom without chartPath
  if (config.environments?.length && config.valuesFilePattern) {
    return {
      layout: 'custom',
      rootPath,
      rootUri,
      workspaceFolder: folder,
      chartPath: chartPathRel,
      environments: config.environments,
      valuesBasePath: config.valuesBasePath ?? '.',
      valuesFilePattern: config.valuesFilePattern,
    };
  }

  // Override-folder
  const overridesPath = path.join(chartPath, config.overridesDir);
  if (fs.existsSync(overridesPath) && fs.statSync(overridesPath).isDirectory()) {
    const overrideFiles = fs.readdirSync(overridesPath);
    const envs = overrideFiles
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => f.replace(/\.(yaml|yml)$/, ''));

    if (envs.length > 0) {
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

  return {
    layout: 'standalone',
    rootPath,
    rootUri,
    workspaceFolder: folder,
    chartPath: chartPathRel,
  };
}

