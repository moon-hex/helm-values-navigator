/** Helm values fallback support: coalesce, or, default, ternary. */

export type FallbackArg = { type: 'values'; path: string } | { type: 'literal'; value: string };

/** @deprecated Use FallbackArg */
export type CoalesceArg = FallbackArg;

export interface DefaultInfo {
  path: string;
  defaultLiteral?: string;
  defaultPath?: string;
}

function parseFallbackArgs(line: string, charOffset: number, fn: string): FallbackArg[] | null {
  const openIdx = line.lastIndexOf('{{', charOffset);
  if (openIdx < 0) return null;
  const closeIdx = line.indexOf('}}', openIdx);
  if (closeIdx < 0 || closeIdx < charOffset) return null;
  const body = line.slice(openIdx, closeIdx + 2);
  const match = body.match(new RegExp(`^\\{\\{-?\\s*${fn}\\s+`, 'i'));
  if (!match) return null;
  const argsStart = openIdx + match[0].length;
  let argsStr = line.slice(argsStart, closeIdx).trimEnd();
  if (argsStr.endsWith('-')) argsStr = argsStr.slice(0, -1).trimEnd();
  const pipeIdx = argsStr.indexOf('|');
  if (pipeIdx >= 0) argsStr = argsStr.slice(0, pipeIdx).trim();
  const tokens = tokenizeArgs(argsStr);
  return tokens;
}

function tokenizeArgs(argsStr: string): FallbackArg[] {
  const tokens: { pos: number; arg: FallbackArg }[] = [];
  const valuesRe = /\.Values\.([a-zA-Z0-9_.-]+)/g;
  const literalRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let m;
  valuesRe.lastIndex = 0;
  while ((m = valuesRe.exec(argsStr)) !== null) {
    tokens.push({ pos: m.index, arg: { type: 'values', path: m[1] } });
  }
  literalRe.lastIndex = 0;
  while ((m = literalRe.exec(argsStr)) !== null) {
    const val = m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2].replace(/\\'/g, "'");
    tokens.push({ pos: m.index, arg: { type: 'literal', value: val } });
  }
  tokens.sort((a, b) => a.pos - b.pos);
  return tokens.map((t) => t.arg);
}

/** Parse coalesce args from template body. Returns null if not a coalesce. */
export function parseCoalesceArgs(line: string, charOffset: number): FallbackArg[] | null {
  return parseFallbackArgs(line, charOffset, 'coalesce');
}

/** Parse or args (2-arg coalesce). Returns null if not an or. */
export function parseOrArgs(line: string, charOffset: number): FallbackArg[] | null {
  const args = parseFallbackArgs(line, charOffset, 'or');
  return args && args.length >= 2 ? args : null;
}

export type FallbackContext =
  | { type: 'coalesce'; args: FallbackArg[] }
  | { type: 'or'; args: FallbackArg[] }
  | { type: 'default'; info: DefaultInfo }
  | { type: 'ternary'; info: TernaryInfo };

/** Single parse to detect which fallback construct (if any) contains pathStr at charOffset. */
export function getFallbackContext(
  line: string,
  pathStr: string,
  charOffset: number
): FallbackContext | null {
  const ctx = extractBlockAndArgs(line, charOffset);
  if (!ctx) return null;
  const { argsStr, args, fn } = ctx;
  if (!args) {
    const defaultInfo = parseDefault(line, pathStr, charOffset);
    return defaultInfo ? { type: 'default', info: defaultInfo } : null;
  }
  const pathIdx = args.findIndex((a) => a.type === 'values' && a.path === pathStr);
  if (pathIdx < 0) return null;
  if (fn === 'coalesce' && args.length >= 2 && pathIdx < args.length - 1)
    return { type: 'coalesce', args };
  if (fn === 'or' && args.length >= 2 && pathIdx < args.length - 1)
    return { type: 'or', args };
  if (fn === 'ternary' && args.length === 3)
    return { type: 'ternary', info: { thenArg: args[0], elseArg: args[1], conditionArg: args[2] } };
  return null;
}

/** Returns true if path has any fallback (coalesce, or, default, ternary). */
export function hasValuesFallback(line: string, pathStr: string, charOffset: number): boolean {
  return getFallbackContext(line, pathStr, charOffset) !== null;
}

function extractBlockAndArgs(
  line: string,
  charOffset: number
): { argsStr: string; args: FallbackArg[] | null; fn: string } | null {
  const openIdx = line.lastIndexOf('{{', charOffset);
  if (openIdx < 0) return null;
  const closeIdx = line.indexOf('}}', openIdx);
  if (closeIdx < 0 || closeIdx < charOffset) return null;
  let argsStr = line
    .slice(openIdx, closeIdx + 2)
    .replace(/^\{\{-?\s*/, '')
    .replace(/\s*-?\}\}$/, '')
    .trim();
  const pipeIdx = argsStr.indexOf('|');
  if (pipeIdx >= 0) argsStr = argsStr.slice(0, pipeIdx).trim();
  const fnMatch = argsStr.match(/^(coalesce|or|ternary)\s+/i);
  if (fnMatch) {
    const fn = fnMatch[1].toLowerCase();
    const rest = argsStr.slice(fnMatch[0].length);
    return { argsStr, args: tokenizeArgs(rest), fn };
  }
  return { argsStr, args: null, fn: '' };
}

/** Returns true if the path at charOffset is in a coalesce with at least one fallback after it. */
export function isInCoalesceWithFallback(
  line: string,
  pathStr: string,
  charOffset: number
): boolean {
  const ctx = getFallbackContext(line, pathStr, charOffset);
  return ctx?.type === 'coalesce';
}

/** Returns true if the path at charOffset is in an or with a fallback. */
export function isInOrWithFallback(
  line: string,
  pathStr: string,
  charOffset: number
): boolean {
  const ctx = getFallbackContext(line, pathStr, charOffset);
  return ctx?.type === 'or';
}

/** Parse default expression. Handles: default "x" .Values.foo and .Values.foo | default "x" */
export function parseDefault(line: string, pathStr: string, charOffset: number): DefaultInfo | null {
  const valuesDotPath = `.Values.${pathStr}`;
  let pathIdx = line.indexOf(valuesDotPath);
  while (pathIdx >= 0) {
    if (charOffset >= pathIdx && charOffset < pathIdx + valuesDotPath.length) break;
    pathIdx = line.indexOf(valuesDotPath, pathIdx + 1);
  }
  if (pathIdx < 0) return null;

  const openIdx = line.lastIndexOf('{{', charOffset);
  if (openIdx < 0 || openIdx > pathIdx) return null;
  const closeIdx = line.indexOf('}}', pathIdx);
  if (closeIdx < 0) return null;

  const argsStr = line.slice(openIdx, closeIdx + 2)
    .replace(/^\{\{-?\s*/, '')
    .replace(/\s*-?\}\}$/, '')
    .trim();

  const pathPos = argsStr.indexOf(valuesDotPath);
  if (pathPos < 0) return null;
  const beforePath = argsStr.slice(0, pathPos).trim();
  const afterPath = argsStr.slice(pathPos + valuesDotPath.length).trim();

  const literalRe = /["']((?:[^"'\\]|\\.)*)["']/;
  const valuesRe = /\.Values\.([a-zA-Z0-9_.-]+)/;
  const matchADirect = beforePath.match(/^default\s+(.+)\s*$/s);
  if (matchADirect) {
    const def = matchADirect[1].trim();
    const lit = def.match(literalRe);
    if (lit) return { path: pathStr, defaultLiteral: lit[1].replace(/\\"/g, '"').replace(/\\'/g, "'") };
    const v = def.match(valuesRe);
    if (v) return { path: pathStr, defaultPath: v[1] };
  }
  const matchBLit = afterPath.match(/\|\s*default\s+["']((?:[^"'\\]|\\.)*)["']/i);
  if (matchBLit) return { path: pathStr, defaultLiteral: matchBLit[1].replace(/\\"/g, '"').replace(/\\'/g, "'") };
  const matchBVal = afterPath.match(/\|\s*default\s+\.Values\.([a-zA-Z0-9_.-]+)/i);
  if (matchBVal) return { path: pathStr, defaultPath: matchBVal[1] };
  return null;
}

/** Returns true if the path has a default fallback. */
export function hasDefaultFallback(line: string, pathStr: string, charOffset: number): boolean {
  return getFallbackContext(line, pathStr, charOffset)?.type === 'default';
}

export function evaluateDefault(
  info: DefaultInfo,
  resolved: Record<string, unknown>,
  getValueAtPath: (obj: Record<string, unknown>, path: string) => unknown
): unknown {
  const val = getValueAtPath(resolved, info.path);
  if (!isEmpty(val)) return val;
  if (info.defaultLiteral !== undefined) return info.defaultLiteral;
  if (info.defaultPath !== undefined) return getValueAtPath(resolved, info.defaultPath);
  return undefined;
}

/** Helm/Go "empty": nil, false, 0, "", [], {}. */
export function isEmpty(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (val === false) return true;
  if (typeof val === 'number' && val === 0) return true;
  if (typeof val === 'string' && val === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  if (typeof val === 'object' && Object.keys(val as object).length === 0) return true;
  return false;
}

export function evaluateCoalesce(
  args: FallbackArg[],
  resolved: Record<string, unknown>,
  getValueAtPath: (obj: Record<string, unknown>, path: string) => unknown
): unknown {
  for (const arg of args) {
    if (arg.type === 'literal') return arg.value;
    const val = getValueAtPath(resolved, arg.path);
    if (!isEmpty(val)) return val;
  }
  return undefined;
}

export interface TernaryInfo {
  thenArg: FallbackArg;
  elseArg: FallbackArg;
  conditionArg: FallbackArg;
}

/** Parse ternary: ternary thenVal elseVal condition. Returns null if not a ternary. */
export function parseTernary(line: string, pathStr: string, charOffset: number): TernaryInfo | null {
  const ctx = getFallbackContext(line, pathStr, charOffset);
  return ctx?.type === 'ternary' ? ctx.info : null;
}

/** Returns true if the path is in a ternary (has conditional fallback). */
export function isInTernary(line: string, pathStr: string, charOffset: number): boolean {
  return getFallbackContext(line, pathStr, charOffset)?.type === 'ternary';
}

function evalArg(
  arg: FallbackArg,
  resolved: Record<string, unknown>,
  getValueAtPath: (obj: Record<string, unknown>, path: string) => unknown
): unknown {
  if (arg.type === 'literal') return arg.value;
  return getValueAtPath(resolved, arg.path);
}

function isTruthy(val: unknown): boolean {
  return !isEmpty(val);
}

export function evaluateTernary(
  info: TernaryInfo,
  resolved: Record<string, unknown>,
  getValueAtPath: (obj: Record<string, unknown>, path: string) => unknown
): unknown {
  const cond = evalArg(info.conditionArg, resolved, getValueAtPath);
  return isTruthy(cond)
    ? evalArg(info.thenArg, resolved, getValueAtPath)
    : evalArg(info.elseArg, resolved, getValueAtPath);
}
