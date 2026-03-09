/** Helm coalesce support: parse args and evaluate. */

export type CoalesceArg = { type: 'values'; path: string } | { type: 'literal'; value: string };

/** Parse coalesce args from template body. Returns null if not a coalesce. */
export function parseCoalesceArgs(line: string, charOffset: number): CoalesceArg[] | null {
  const openIdx = line.lastIndexOf('{{', charOffset);
  if (openIdx < 0) return null;
  const closeIdx = line.indexOf('}}', openIdx);
  if (closeIdx < 0 || closeIdx < charOffset) return null;
  const body = line.slice(openIdx, closeIdx + 2);
  const match = body.match(/^\{\{-?\s*coalesce\s+/i);
  if (!match) return null;
  const argsStart = openIdx + match[0].length;
  let argsStr = line.slice(argsStart, closeIdx).trimEnd();
  if (argsStr.endsWith('-')) argsStr = argsStr.slice(0, -1).trimEnd();
  const pipeIdx = argsStr.indexOf('|');
  if (pipeIdx >= 0) argsStr = argsStr.slice(0, pipeIdx).trim();
  const tokens: { pos: number; arg: CoalesceArg }[] = [];
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

/** Returns true if the path at charOffset is in a coalesce with at least one fallback after it. */
export function isInCoalesceWithFallback(
  line: string,
  pathStr: string,
  charOffset: number
): boolean {
  const args = parseCoalesceArgs(line, charOffset);
  if (!args || args.length < 2) return false;
  const pathIdx = args.findIndex((a) => a.type === 'values' && a.path === pathStr);
  if (pathIdx < 0) return false;
  return pathIdx < args.length - 1;
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
  args: CoalesceArg[],
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
