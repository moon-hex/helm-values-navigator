import * as fs from 'fs';
import * as path from 'path';

const DEFINE_REGEX = /\{\{-?\s*define\s+"([^"]+)"\s*-?\}\}/;
const END_REGEX = /\{\{-?\s*end\s*-?\}\}/g;
const NEXT_DEFINE_REGEX = /\{\{-?\s*define\s+"/g;

/**
 * Find the templates directory containing the given file path.
 * Walks up from the file's directory until we find a folder named "templates".
 */
export function getTemplatesDir(documentPath: string): string | null {
  let dir = path.dirname(documentPath);
  const root = path.parse(documentPath).root;
  while (dir !== root) {
    if (path.basename(dir) === 'templates') {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Extract the body of a define block. Handles nested if/with/range by
 * finding the last {{ end }} before the next {{ define }}.
 */
function extractDefineBlock(content: string, defineStartIndex: number): string | null {
  const afterDefine = content.slice(defineStartIndex);
  const defineMatches = [...afterDefine.matchAll(NEXT_DEFINE_REGEX)];
  const searchEnd = defineMatches[1] ? defineMatches[1].index : afterDefine.length;
  const blockContent = afterDefine.slice(0, searchEnd);

  let lastEndMatch: RegExpExecArray | null = null;
  END_REGEX.lastIndex = 0;
  let match;
  while ((match = END_REGEX.exec(blockContent)) !== null) {
    lastEndMatch = match;
  }
  if (!lastEndMatch) return null;

  const block = blockContent.slice(0, lastEndMatch.index + lastEndMatch[0].length);
  return block.trim();
}

/**
 * Find the template definition for the given name in the templates directory.
 * Returns the define block content or null if not found.
 */
export function findTemplateDefinition(
  templateName: string,
  templatesDir: string
): { content: string; file: string } | null {
  const ext = ['.yaml', '.yml', '.tpl'];
  const files: string[] = [];

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'charts') {
            walk(fullPath);
          }
        } else if (ext.some((e) => entry.name.endsWith(e))) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore
    }
  }

  walk(templatesDir);

  const escaped = templateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defineRe = new RegExp(
    `\\{\\{-?\\s*define\\s+"${escaped}"\\s*-?\\}\\}`,
    'i'
  );

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const defineMatch = content.match(defineRe);
      if (defineMatch && defineMatch.index !== undefined) {
        const block = extractDefineBlock(content, defineMatch.index);
        if (block) {
          return { content: block, file: path.basename(file) };
        }
      }
    } catch {
      // Skip
    }
  }
  return null;
}

/**
 * Find the file and range of a template define. For go-to-definition.
 */
export function findTemplateDefinitionLocation(
  templateName: string,
  templatesDir: string
): { filePath: string; range: { line: number; startChar: number; endChar: number } } | null {
  const ext = ['.yaml', '.yml', '.tpl'];
  const files: string[] = [];

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'charts') {
            walk(fullPath);
          }
        } else if (ext.some((e) => entry.name.endsWith(e))) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore
    }
  }

  walk(templatesDir);

  const escaped = templateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defineRe = new RegExp(
    `\\{\\{-?\\s*define\\s+"(${escaped})"\\s*-?\\}\\}`,
    'i'
  );

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const defineMatch = content.match(defineRe);
      if (defineMatch && defineMatch.index !== undefined && defineMatch[1]) {
        const matchStart = defineMatch.index;
        const nameInFile = defineMatch[1]; // actual name (may differ in case)
        const nameOffset = defineMatch[0].indexOf(`"${nameInFile}"`) + 1; // +1 past opening quote
        const nameStart = matchStart + nameOffset;
        const nameEnd = nameStart + nameInFile.length;
        const before = content.slice(0, nameStart);
        const lines = before.split(/\r?\n/);
        const line = lines.length - 1;
        const lastLine = lines[lines.length - 1] ?? '';
        const startChar = nameStart - (before.length - lastLine.length);
        const endChar = startChar + nameInFile.length;
        return {
          filePath,
          range: { line, startChar, endChar },
        };
      }
    } catch {
      // Skip
    }
  }
  return null;
}
