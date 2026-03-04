// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import * as jsonc from "jsonc-parser";

const SCHEME = "wp-css";

type CssTarget = {
  sourceUri: vscode.Uri;
  // range covering ONLY the inner content of the JSON string (no surrounding quotes)
  contentRange: vscode.Range;
  rawEscapedContent: string; // e.g. contains \" etc
};

function findCssAtCursor(doc: vscode.TextDocument, pos: vscode.Position): CssTarget | null {
  const text = doc.getText();
  const offset = doc.offsetAt(pos);
  const tree = jsonc.parseTree(text);
  if (!tree) return null;

  // Smallest node containing cursor
  let node = jsonc.findNodeAtOffset(tree, offset);
  if (!node) return null;

  // Walk up to a property whose key is "css"
  while (node) {
    const p = node.parent;
    if (p?.type === "property" && p.children?.length === 2) {
      const key = p.children[0];
      const value = p.children[1];
      if (key.value === "css" && value.type === "string") {
        // jsonc string node includes quotes in its [offset, length]
        const start = value.offset + 1;
        const end = value.offset + value.length - 1;

        const contentRange = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
        const rawEscapedContent = doc.getText(contentRange);

        return { sourceUri: doc.uri, contentRange, rawEscapedContent };
      }
    }
    node = node.parent!;
  }

  return null;
}

function unescapeJsonString(inner: string): string {
  // Parse `\"` escaped quotes from JSON string into normal double quote marks.
  return inner.replace(/\\"/g, '"');
}

function escapeForJsonString(text: string): string {
  // JSON.stringify returns quoted string; strip surrounding quotes.
  return JSON.stringify(text).slice(1, -1);
}

class InlineCssProvider implements vscode.TextDocumentContentProvider {
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.onDidChangeEmitter.event;

  // map virtual uri -> target (and keep it updated)
  private targets = new Map<string, CssTarget>();

  setTarget(uri: vscode.Uri, target: CssTarget) {
    this.targets.set(uri.toString(), target);
    this.onDidChangeEmitter.fire(uri);
  }

  getTarget(uri: vscode.Uri) {
    return this.targets.get(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const t = this.targets.get(uri.toString());
    if (!t) return "/* No target found */";
    return unescapeJsonString(t.rawEscapedContent);
  }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const provider = new InlineCssProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider)
  );

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  context.subscriptions.push(
    vscode.commands.registerCommand("wpThemeJsonCss.editInlineCss", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const target = findCssAtCursor(editor.document, editor.selection.active);
      if (!target) {
        vscode.window.showErrorMessage('Place the cursor inside a "css" string value.');
        return;
      }

      // Use .css suffix to strongly encourage CSS mode
      const virtualUri = vscode.Uri.parse(
        `${SCHEME}:/inline/themejson.css?src=${encodeURIComponent(target.sourceUri.toString())}`
      );

      provider.setTarget(virtualUri, target);

      const vdoc = await vscode.workspace.openTextDocument(virtualUri);

      // Force CSS language mode just in case
      const cssDoc = await vscode.languages.setTextDocumentLanguage(vdoc, "css");

      await vscode.window.showTextDocument(cssDoc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false
      });
    })
  );

  // Save virtual -> write back into JSON
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme !== SCHEME) return;

      const target = provider.getTarget(doc.uri);
      if (!target) return;

      const escaped = escapeForJsonString(doc.getText());

      const edit = new vscode.WorkspaceEdit();
      edit.replace(target.sourceUri, target.contentRange, escaped);

      await vscode.workspace.applyEdit(edit);

      // Optional: auto-save the source file too (nice UX)
      const sourceDoc = await vscode.workspace.openTextDocument(target.sourceUri);
      await sourceDoc.save();
    })
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}
