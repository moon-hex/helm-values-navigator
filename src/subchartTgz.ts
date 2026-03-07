import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';

const VALUES_PATH_REGEX = /\.Values\.([a-zA-Z0-9_.-]+)/g;

/** Cache: tgzPath -> { mtime, paths } */
const tgzPathsCache = new Map<string, { mtime: number; paths: Set<string> }>();

function extractPathsFromText(text: string): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  VALUES_PATH_REGEX.lastIndex = 0;
  while ((match = VALUES_PATH_REGEX.exec(text)) !== null) {
    results.push(match[1]);
  }
  return results;
}

function walkTemplates(dir: string, depName: string, out: Set<string>): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'charts') {
        walkTemplates(fullPath, depName, out);
      } else if (/\.(yaml|yml|tpl)$/.test(entry.name)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const p of extractPathsFromText(content)) {
          out.add(depName + '.' + p);
        }
      }
    }
  } catch {
    // ignore
  }
}

/** Extract .Values paths from subchart tgz. Cached by tgz path + mtime. */
export function getValuesPathsFromTgz(tgzPath: string, depName: string): Set<string> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(tgzPath);
  } catch {
    return new Set();
  }
  const cached = tgzPathsCache.get(tgzPath);
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.paths;
  }
  const tempDir = path.join(os.tmpdir(), 'helm-values-nav-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    tar.extract({ file: tgzPath, cwd: tempDir, sync: true });
    const paths = new Set<string>();
    const entries = fs.readdirSync(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const templatesDir = path.join(tempDir, entry.name, 'templates');
        if (fs.existsSync(templatesDir) && fs.statSync(templatesDir).isDirectory()) {
          walkTemplates(templatesDir, depName, paths);
        }
      }
    }
    tgzPathsCache.set(tgzPath, { mtime: stat.mtimeMs, paths });
    return paths;
  } catch {
    return new Set();
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
