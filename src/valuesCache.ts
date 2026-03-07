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

export function getCached(folderUri: string): CachedHoverData | null {
  return hoverCache.get(folderUri) ?? null;
}

export function setCached(folderUri: string, data: CachedHoverData): void {
  hoverCache.set(folderUri, data);
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
    const key = folder.uri.toString();
    hoverCache.delete(key);
    diagnosticsCache.delete(key);
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
