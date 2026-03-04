// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import * as jsonc from "jsonc-parser";
import prettier from "prettier";
import postcss from "postcss";
import cssnano from "cssnano";

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

async function minifyCss(css: string): Promise<string> {
  const sortDeclarations = vscode.workspace
    .getConfiguration("wpThemeJsonCss")
    .get<boolean>("sortDeclarations", false);

  const result = await postcss([
    cssnano({
      preset: ["default", { cssDeclarationSorter: sortDeclarations }],
    }),
  ]).process(css, {
    from: undefined,
  });
  return result.css.trim();
}

function escapeForJsonString(text: string): string {
  // JSON.stringify returns quoted string; strip surrounding quotes.
  return JSON.stringify(text).slice(1, -1);
}

const targetsByCssDocUri = new Map<string, CssTarget>();

async function formatCss(css: string): Promise<string> {
  try {
    return await prettier.format(css, {
      parser: "css",
      printWidth: 80
    });
  } catch {
    // If Prettier fails (rare but possible with unusual syntax),
    // just return the raw CSS so the editor still opens.
    return css;
  }
}

/**
 * In-memory file system provider for the wp-css:/ scheme.
 *
 * Unlike TextDocumentContentProvider (which is read-only), a
 * FileSystemProvider gives us real read/write virtual files.
 * When the user presses Cmd+S the editor calls writeFile() and
 * onDidSaveTextDocument fires normally — no "Save As" dialog.
 */
class CssFileSystemProvider implements vscode.FileSystemProvider {
  private files = new Map<string, Uint8Array>();
  private timestamps = new Map<string, number>();

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const data = this.files.get(uri.toString());
    if (data !== undefined) {
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: this.timestamps.get(uri.toString()) ?? Date.now(),
        size: data.length,
      };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {}

  readFile(uri: vscode.Uri): Uint8Array {
    const data = this.files.get(uri.toString());
    if (data !== undefined) {
      return data;
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean }
  ): void {
    this.files.set(uri.toString(), content);
    this.timestamps.set(uri.toString(), Date.now());
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(uri: vscode.Uri): void {
    this.files.delete(uri.toString());
    this.timestamps.delete(uri.toString());
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Not supported");
  }
}

let cssFileCounter = 0;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const fsProvider = new CssFileSystemProvider();

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, {
      isCaseSensitive: true,
    })
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

      const cssRaw = unescapeJsonString(target.rawEscapedContent);
      const cssPretty = await formatCss(cssRaw);

      // Create a virtual file in our in-memory FS so Cmd+S works normally
      const cssUri = vscode.Uri.parse(`${SCHEME}:/inline-${cssFileCounter++}.css`);
      fsProvider.writeFile(cssUri, Buffer.from(cssPretty), {
        create: true,
        overwrite: true,
      });

      // Store mapping: virtual css doc URI -> JSON target
      targetsByCssDocUri.set(cssUri.toString(), target);

      const cssDoc = await vscode.workspace.openTextDocument(cssUri);
      await vscode.window.showTextDocument(cssDoc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
    })
  );

  // Save virtual -> write back into JSON
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const target = targetsByCssDocUri.get(doc.uri.toString());
      if (!target) return;

      // Take edited CSS, minify + escape, and write back into the JSON string
      const editedCss = doc.getText();
      const minified = await minifyCss(editedCss);
      const escaped = escapeForJsonString(minified);

      const edit = new vscode.WorkspaceEdit();
      edit.replace(target.sourceUri, target.contentRange, escaped);
      await vscode.workspace.applyEdit(edit);

      // Re-read the source document so we can update the stored range
      // (the content length likely changed, shifting offsets).
      const sourceDoc = await vscode.workspace.openTextDocument(target.sourceUri);
      await sourceDoc.save();

      // Refresh the target so subsequent saves still hit the right range
      const updatedTarget = findCssAtCursor(
        sourceDoc,
        target.contentRange.start
      );
      if (updatedTarget) {
        targetsByCssDocUri.set(doc.uri.toString(), updatedTarget);
      }
    })
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}
