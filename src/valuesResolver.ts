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

/** Resolve values for custom layout (explicit environments + valuesFilePattern). */
export function getResolvedValuesCustom(
  workspaceRoot: string,
  chartPath: string,
  baseValuesFile: string,
  valuesBasePath: string,
  valuesFilePattern: string,
  envName: string
): ResolvedValues {
  const layersLoaded: string[] = [];
  const missingLayers: string[] = [];
  const chartRoot = path.join(workspaceRoot, chartPath);
  const basePath = path.join(chartRoot, baseValuesFile);
  const valuesFilePath = path.join(
    workspaceRoot,
    valuesBasePath,
    valuesFilePattern.replace(/{env}/g, envName)
  );

  let merged: Record<string, unknown> = {};
  const baseContent = loadYamlFile(basePath);
  if (baseContent) {
    merged = { ...baseContent };
    layersLoaded.push(baseValuesFile);
  } else {
    missingLayers.push(baseValuesFile);
  }

  const envContent = loadYamlFile(valuesFilePath);
  const envRel = path.relative(workspaceRoot, valuesFilePath);
  if (envContent) {
    merged = deepMerge(merged, envContent) as Record<string, unknown>;
    layersLoaded.push(envRel);
  } else {
    missingLayers.push(envRel);
  }

  return {
    env: envName,
    values: merged,
    layersLoaded,
    missingLayers,
  };
}

/** Override-only for custom layout. */
export function getOverrideOnlyValuesCustom(
  workspaceRoot: string,
  valuesBasePath: string,
  valuesFilePattern: string,
  envName: string
): Record<string, unknown> {
  const valuesFilePath = path.join(
    workspaceRoot,
    valuesBasePath,
    valuesFilePattern.replace(/{env}/g, envName)
  );
  return loadYamlFile(valuesFilePath) ?? {};
}

/** Find the line and character range for a dotted key path in YAML content. */
export function findKeyRangeInYaml(
  content: string,
  dottedPath: string
): { line: number; startChar: number; endChar: number } | null {
  const lines = content.split(/\r?\n/);
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

/** Flatten object to dotted leaf paths (e.g. {a: {b: 1}} -> ["a.b"]). */
export function flattenLeafKeys(
  obj: Record<string, unknown>,
  prefix = ''
): string[] {
  const result: string[] = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      val !== null &&
      val !== undefined &&
      typeof val === 'object' &&
      !Array.isArray(val)
    ) {
      result.push(...flattenLeafKeys(val as Record<string, unknown>, path));
    } else {
      result.push(path);
    }
  }
  return result;
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

/** Collect all values file paths for a layout (for go-to-definition). */
export function getValuesFilePaths(
  rootPath: string,
  chartPath: string,
  baseValuesFile: string,
  layout: {
    layout: string;
    valueFileTemplates?: string[];
    environments?: string[];
    overridesDir?: string;
    valuesBasePath?: string;
    valuesFilePattern?: string;
  },
  secretsFilePath?: string
): string[] {
  const chartRoot = path.join(rootPath, chartPath);
  const basePath = path.join(chartRoot, baseValuesFile);
  const paths = new Set<string>();
  paths.add(basePath);

  const envs = layout.environments ?? ['default'];

  if (layout.layout === 'helmfile' && layout.valueFileTemplates) {
    for (const env of envs) {
      for (const template of layout.valueFileTemplates) {
        let filePath = path.join(rootPath, resolveValueFileTemplate(template, env));
        if (secretsFilePath && /secrets\.(yaml|yml)$/i.test(resolveValueFileTemplate(template, 'x'))) {
          filePath = path.isAbsolute(secretsFilePath)
            ? secretsFilePath
            : path.join(rootPath, secretsFilePath);
        }
        paths.add(filePath);
      }
    }
  } else if (layout.layout === 'override-folder' && layout.overridesDir) {
    const overrideDir = path.join(chartRoot, layout.overridesDir);
    for (const env of envs) {
      paths.add(path.join(overrideDir, `${env}.yaml`));
      paths.add(path.join(overrideDir, `${env}.yml`));
    }
  } else if (layout.layout === 'custom' && layout.valuesBasePath && layout.valuesFilePattern) {
    for (const env of envs) {
      paths.add(
        path.join(rootPath, layout.valuesBasePath, layout.valuesFilePattern.replace(/{env}/g, env))
      );
    }
  }

  return [...paths];
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
