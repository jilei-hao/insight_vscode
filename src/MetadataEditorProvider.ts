import * as vscode from 'vscode';
import * as path from 'path';
import { getMetadata, ImageMetadata, MetadataField } from './parsers/index';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function groupFields(fields: MetadataField[]): Map<string, MetadataField[]> {
  const groups = new Map<string, MetadataField[]>();
  for (const field of fields) {
    const group = field.group ?? 'General';
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group)!.push(field);
  }
  return groups;
}

function buildHtml(fsPath: string, metadata: ImageMetadata): string {
  const filename = path.basename(fsPath);
  const groups = groupFields(metadata.fields);

  let tableRows = '';

  if (metadata.error && metadata.fields.length === 0) {
    tableRows = `
      <tr class="error-row">
        <td colspan="2" class="error-cell">
          <span class="error-icon">⚠</span>
          ${escapeHtml(metadata.error)}
        </td>
      </tr>`;
  } else {
    let lastGroup = '';
    for (const [groupName, fields] of groups) {
      if (groupName !== lastGroup) {
        tableRows += `
          <tr class="group-header">
            <th colspan="2">${escapeHtml(groupName)}</th>
          </tr>`;
        lastGroup = groupName;
      }
      for (const field of fields) {
        tableRows += `
          <tr>
            <td class="label-cell">${escapeHtml(field.label)}</td>
            <td class="value-cell">${escapeHtml(field.value)}</td>
          </tr>`;
      }
    }

    if (metadata.error) {
      tableRows += `
        <tr class="group-header">
          <th colspan="2">Warning</th>
        </tr>
        <tr class="error-row">
          <td colspan="2" class="error-cell">
            <span class="error-icon">⚠</span>
            ${escapeHtml(metadata.error)}
          </td>
        </tr>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Medical Image Metadata</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --border: var(--vscode-panel-border, #424242);
      --header-bg: var(--vscode-sideBarSectionHeader-background, #252526);
      --header-fg: var(--vscode-sideBarSectionHeader-foreground, #bbbbbe);
      --row-hover: var(--vscode-list-hoverBackground, #2a2d2e);
      --label-fg: var(--vscode-descriptionForeground, #9d9d9d);
      --badge-bg: var(--vscode-badge-background, #007acc);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      --mono: var(--vscode-editor-font-family, 'Courier New', monospace);
      --error-bg: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      --error-fg: var(--vscode-inputValidation-errorForeground, #f48771);
      --error-border: var(--vscode-inputValidation-errorBorder, #be1100);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.5;
      padding: 16px;
    }

    .header {
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .filename {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 4px;
      word-break: break-all;
    }

    .filepath {
      font-size: 11px;
      color: var(--label-fg);
      word-break: break-all;
      font-family: var(--mono);
    }

    .meta-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
    }

    .format-badge {
      display: inline-block;
      background: var(--badge-bg);
      color: var(--badge-fg);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 3px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    .brief-text {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--label-fg);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    .group-header th {
      text-align: left;
      background: var(--header-bg);
      color: var(--header-fg);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 6px 8px;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }

    tr:not(.group-header):hover {
      background: var(--row-hover);
    }

    td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }

    .label-cell {
      width: 40%;
      color: var(--label-fg);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .value-cell {
      width: 60%;
      font-family: var(--mono);
      font-size: 12px;
      word-break: break-word;
    }

    .error-cell {
      padding: 10px 12px;
      background: var(--error-bg);
      color: var(--error-fg);
      border: 1px solid var(--error-border);
      border-radius: 3px;
      font-size: 12px;
    }

    .error-icon {
      margin-right: 6px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="filename">${escapeHtml(filename)}</div>
    <div class="filepath">${escapeHtml(fsPath)}</div>
    <div class="meta-row">
      <span class="format-badge">${escapeHtml(metadata.format)}</span>
      <span class="brief-text">${escapeHtml(metadata.brief)}</span>
    </div>
  </div>
  <table>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
</body>
</html>`;
}

interface MedicalImageDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

export class MetadataEditorProvider implements vscode.CustomReadonlyEditorProvider<MedicalImageDocument> {
  public static readonly viewType = 'medicalImageInsight.metadataViewer';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MetadataEditorProvider.viewType,
      new MetadataEditorProvider(),
      {
        webviewOptions: { retainContextWhenHidden: false },
        supportsMultipleEditorsPerDocument: true,
      }
    );
  }

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): MedicalImageDocument {
    return { uri, dispose: () => {} };
  }

  resolveCustomEditor(
    document: MedicalImageDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    webviewPanel.webview.options = { enableScripts: false };

    const metadata = getMetadata(document.uri.fsPath);
    webviewPanel.webview.html = buildHtml(document.uri.fsPath, metadata);
  }
}
