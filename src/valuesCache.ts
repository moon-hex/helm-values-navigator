import * as path from 'path';
import * as vscode from 'vscode';
import type { ResolvedLayout } from './layout';

export interface CachedHoverData {
  layout: ResolvedLayout;
  baseValues: Record<string, unknown>;
  perEnv: Map<string, { resolved: Record<string, unknown>; overrideOnly: Record<string, unknown> }>;
}

const hoverCache = new Map<string, CachedHoverData>();
const diagnosticsCache = new Map<string, Map<string, vscode.Diagnostic[]>>();

/** Cache key: folderUri or folderUri + chartPath for multi-chart. */
export function cacheKey(folderUri: string, chartPath?: string): string {
  return chartPath ? `${folderUri}::${chartPath}` : folderUri;
}

function isRelevantForInvalidation(doc: vscode.TextDocument): boolean {
  const p = doc.uri.fsPath;
  const sep = path.sep;
  return (
    p.includes(sep + 'templates' + sep) ||
    doc.fileName.endsWith('values.yaml') ||
    doc.fileName.endsWith('values.yml') ||
    doc.fileName.endsWith('Chart.yaml') ||
    doc.fileName.endsWith(sep + 'Chart.yaml') ||
    doc.fileName.endsWith('helmfile.yaml') ||
    p.includes(sep + 'overrides' + sep)
  );
}

export function getCached(key: string): CachedHoverData | null {
  return hoverCache.get(key) ?? null;
}

export function setCached(key: string, data: CachedHoverData): void {
  hoverCache.set(key, data);
}

export function getCachedDiagnostics(folderUri: string): Map<string, vscode.Diagnostic[]> | null {
  return diagnosticsCache.get(folderUri) ?? null;
}

export function setCachedDiagnostics(folderUri: string, data: Map<string, vscode.Diagnostic[]>): void {
  diagnosticsCache.set(folderUri, data);
}

export function invalidateForDocument(doc: vscode.TextDocument): void {
  if (!isRelevantForInvalidation(doc)) return;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (folder) {
    const folderKey = folder.uri.toString();
    // Invalidate all cache entries for this folder (single-chart and multi-chart)
    for (const key of hoverCache.keys()) {
      if (key === folderKey || key.startsWith(folderKey + '::')) {
        hoverCache.delete(key);
      }
    }
    diagnosticsCache.delete(folderKey);
  }
}

export function invalidateAll(): void {
  hoverCache.clear();
  diagnosticsCache.clear();
}

export function registerCacheInvalidation(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(invalidateForDocument),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('helmValues')) invalidateAll();
    })
  );
}
