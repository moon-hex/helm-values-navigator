import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ResolvedValues {
  env: string;
  values: Record<string, unknown>;
  layersLoaded: string[];
  missingLayers: string[];
}

export interface ValuesResolverContext {
  workspaceRoot: string;
  chartPath: string; // Relative to workspace root (e.g. "nolo")
  baseValuesFile: string;
  valueFileTemplates: string[]; // e.g. ["./values/values-{{ .Environment.Name }}.yml", "./secrets.yml"]
  secretsFilePath?: string; // Override when secrets file is git-ignored
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (source === null || source === undefined) {
    return target;
  }
  if (target === null || target === undefined) {
    return source;
  }
  if (typeof source !== 'object' || Array.isArray(source)) {
    return source;
  }
  if (typeof target !== 'object' || Array.isArray(target)) {
    return source;
  }
  const result = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(source as Record<string, unknown>)) {
    const srcVal = (source as Record<string, unknown>)[key];
    const tgtVal = (target as Record<string, unknown>)[key];
    if (
      typeof srcVal === 'object' &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === 'object' &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function loadYamlFile(filePath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(content);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return null;
  }
}

export function parseHelmfile(helmfilePath: string): {
  environments: string[];
  chartPath: string;
  valueFileTemplates: string[];
} | null {
  try {
    const content = fs.readFileSync(helmfilePath, 'utf8');
    const doc = yaml.load(content) as Record<string, unknown> | null;
    if (!doc || typeof doc !== 'object') return null;

    const environments = doc.environments
      ? Object.keys(doc.environments as Record<string, unknown>)
      : [];
    const releases = (doc.releases as unknown[]) || [];
    const firstRelease = releases[0] as Record<string, unknown> | undefined;
    const chartPath = firstRelease?.chart ? String(firstRelease.chart).replace(/^\.\//, '') : '.';
    const values = (firstRelease?.values as string[]) || [];
    const valueFileTemplates = values.filter((v): v is string => typeof v === 'string');

    return { environments, chartPath, valueFileTemplates };
  } catch {
    return null;
  }
}

function resolveValueFileTemplate(
  template: string,
  envName: string
): string {
  return template.replace(/\{\{\s*\.Environment\.Name\s*\}\}/g, envName);
}

function isSecretsFile(template: string): boolean {
  const resolved = resolveValueFileTemplate(template, 'x');
  return /secrets\.(yaml|yml)$/i.test(resolved);
}

export function getResolvedValues(
  ctx: ValuesResolverContext,
  envName: string
): ResolvedValues {
  const layersLoaded: string[] = [];
  const missingLayers: string[] = [];
  let merged: Record<string, unknown> = {};

  const chartRoot = path.join(ctx.workspaceRoot, ctx.chartPath);
  const basePath = path.join(chartRoot, ctx.baseValuesFile);

  // 1. Chart base values
  const baseContent = loadYamlFile(basePath);
  if (baseContent) {
    merged = { ...baseContent };
    layersLoaded.push(ctx.baseValuesFile);
  } else {
    missingLayers.push(ctx.baseValuesFile);
  }

  // 2. Value layers from templates
  for (const template of ctx.valueFileTemplates) {
    let filePath = path.join(ctx.workspaceRoot, resolveValueFileTemplate(template, envName));
    if (ctx.secretsFilePath && isSecretsFile(template)) {
      filePath = path.isAbsolute(ctx.secretsFilePath)
        ? ctx.secretsFilePath
        : path.join(ctx.workspaceRoot, ctx.secretsFilePath);
    }
    const relPath = path.relative(ctx.workspaceRoot, filePath);
    const content = loadYamlFile(filePath);
    if (content) {
      merged = deepMerge(merged, content) as Record<string, unknown>;
      layersLoaded.push(relPath);
    } else {
      missingLayers.push(relPath);
    }
  }

  return {
    env: envName,
    values: merged,
    layersLoaded,
    missingLayers,
  };
}

/** Merge override layers only (no base). Used to detect if a path is explicitly overridden. */
export function getOverrideOnlyValues(
  ctx: ValuesResolverContext,
  envName: string
): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const template of ctx.valueFileTemplates) {
    let filePath = path.join(ctx.workspaceRoot, resolveValueFileTemplate(template, envName));
    if (ctx.secretsFilePath && isSecretsFile(template)) {
      filePath = path.isAbsolute(ctx.secretsFilePath)
        ? ctx.secretsFilePath
        : path.join(ctx.workspaceRoot, ctx.secretsFilePath);
    }
    const content = loadYamlFile(filePath);
    if (content) {
      merged = deepMerge(merged, content) as Record<string, unknown>;
    }
  }
  return merged;
}

/** Override-only for override-folder layout. */
export function getOverrideOnlyValuesOverrideFolder(
  workspaceRoot: string,
  chartPath: string,
  overridesDir: string,
  envName: string
): Record<string, unknown> {
  const overridePathYaml = path.join(workspaceRoot, chartPath, overridesDir, `${envName}.yaml`);
  const overridePathYml = path.join(workspaceRoot, chartPath, overridesDir, `${envName}.yml`);
  return loadYamlFile(overridePathYaml) ?? loadYamlFile(overridePathYml) ?? {};
}

/** Get value at dotted path (e.g. "global.nolo.cache.endpoint.ip"). Returns undefined if not found. */
export function getValueAtPath(
  obj: Record<string, unknown>,
  dottedPath: string
): unknown {
  const parts = dottedPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Load base values only (chart values.yaml). */
export function getBaseValues(
  workspaceRoot: string,
  chartPath: string,
  baseValuesFile: string
): Record<string, unknown> {
  const basePath = path.join(workspaceRoot, chartPath, baseValuesFile);
  return loadYamlFile(basePath) ?? {};
}

export function getResolvedValuesOverrideFolder(
  workspaceRoot: string,
  chartPath: string,
  baseValuesFile: string,
  overridesDir: string,
  envName: string
): ResolvedValues {
  const layersLoaded: string[] = [];
  const missingLayers: string[] = [];
  const chartRoot = path.join(workspaceRoot, chartPath);
  const basePath = path.join(chartRoot, baseValuesFile);
  const overrideDirPath = path.join(chartRoot, overridesDir);

  let merged: Record<string, unknown> = {};
  const baseContent = loadYamlFile(basePath);
  if (baseContent) {
    merged = { ...baseContent };
    layersLoaded.push(baseValuesFile);
  } else {
    missingLayers.push(baseValuesFile);
  }

  const overridePathYaml = path.join(overrideDirPath, `${envName}.yaml`);
  const overridePathYml = path.join(overrideDirPath, `${envName}.yml`);
  const overrideContent =
    loadYamlFile(overridePathYaml) ?? loadYamlFile(overridePathYml);
  const overrideRel = fs.existsSync(overridePathYaml)
    ? path.join(overridesDir, `${envName}.yaml`)
    : path.join(overridesDir, `${envName}.yml`);
  if (overrideContent) {
    merged = deepMerge(merged, overrideContent) as Record<string, unknown>;
    layersLoaded.push(overrideRel);
  } else {
    missingLayers.push(overrideRel);
  }

  return {
    env: envName,
    values: merged,
    layersLoaded,
    missingLayers,
  };
}
