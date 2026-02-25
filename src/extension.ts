import * as vscode from 'vscode';
import { MetadataEditorProvider } from './MetadataEditorProvider';
import { MetadataDecorationProvider } from './MetadataDecorationProvider';

export function activate(context: vscode.ExtensionContext): void {
  // 1. Register the custom editor provider (webview for medical image files)
  const editorProviderDisposable = MetadataEditorProvider.register(context);
  context.subscriptions.push(editorProviderDisposable);

  // 2. Register the file decoration provider (Explorer badge + tooltip)
  const decorationProvider = new MetadataDecorationProvider();
  const decorationDisposable = vscode.window.registerFileDecorationProvider(decorationProvider);
  context.subscriptions.push(decorationDisposable, decorationProvider);

  // 3. Register the "Show Medical Image Metadata" command
  const commandDisposable = vscode.commands.registerCommand(
    'medicalImageInsight.showMetadata',
    async (uri?: vscode.Uri) => {
      // Resolve the target URI: command arg → active editor → prompt
      let targetUri = uri;

      if (!targetUri) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          targetUri = activeEditor.document.uri;
        }
      }

      if (!targetUri) {
        vscode.window.showErrorMessage('No file selected. Open a medical image file first.');
        return;
      }

      // Open the file with our custom editor view type
      await vscode.commands.executeCommand(
        'vscode.openWith',
        targetUri,
        MetadataEditorProvider.viewType
      );
    }
  );
  context.subscriptions.push(commandDisposable);
}

export function deactivate(): void {
  // No-op: VS Code handles cleanup via context.subscriptions
}
