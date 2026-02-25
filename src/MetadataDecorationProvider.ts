import * as vscode from 'vscode';
import * as path from 'path';
import { getMetadata } from './parsers/index';

const SUPPORTED_EXTENSIONS = new Set([
  '.nii', '.nii.gz', '.nrrd', '.seq.nrrd', '.vtk', '.vtp', '.vti',
]);

function getFileExtension(fsPath: string): string {
  const basename = path.basename(fsPath);
  if (basename.endsWith('.nii.gz')) { return '.nii.gz'; }
  if (basename.endsWith('.seq.nrrd')) { return '.seq.nrrd'; }
  return path.extname(fsPath).toLowerCase();
}

function isSupportedFile(uri: vscode.Uri): boolean {
  const ext = getFileExtension(uri.fsPath);
  return SUPPORTED_EXTENSIONS.has(ext);
}

export class MetadataDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _cache = new Map<string, vscode.FileDecoration>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();

  public readonly onDidChangeFileDecorations = this._onDidChange.event;

  provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') { return undefined; }
    if (!isSupportedFile(uri)) { return undefined; }

    const cached = this._cache.get(uri.fsPath);
    if (cached) { return cached; }

    try {
      const metadata = getMetadata(uri.fsPath);
      const tooltip = metadata.brief.length > 100
        ? metadata.brief.substring(0, 97) + '...'
        : metadata.brief;

      const decoration: vscode.FileDecoration = {
        badge: 'IM',
        tooltip: metadata.error
          ? `Error: ${metadata.error.substring(0, 80)}`
          : tooltip,
        color: metadata.error
          ? new vscode.ThemeColor('list.warningForeground')
          : new vscode.ThemeColor('charts.blue'),
      };

      this._cache.set(uri.fsPath, decoration);
      return decoration;
    } catch {
      // On error, return a minimal decoration without crashing
      return {
        badge: 'IM',
        tooltip: 'Could not read metadata',
        color: new vscode.ThemeColor('list.warningForeground'),
      };
    }
  }

  /** Call this to invalidate cache entries (e.g., after file changes). */
  invalidate(uri?: vscode.Uri): void {
    if (uri) {
      this._cache.delete(uri.fsPath);
      this._onDidChange.fire(uri);
    } else {
      this._cache.clear();
      // Fire for all cached URIs — simplified: fire a dummy event
      this._onDidChange.fire(vscode.Uri.parse('file:///'));
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
