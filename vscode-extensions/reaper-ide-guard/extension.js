const path = require("path");
const vscode = require("vscode");

const CONTEXT_KEY = "reaper.ideGuard.active";
const BLOCKED_OPEN_FILE_MESSAGE =
  "This IDE session is locked to the current project. Use the Reaper launcher to open a different project.";
const BLOCKED_OPEN_FOLDER_MESSAGE =
  "Open Folder is disabled inside an isolated IDE session. Open a different project from the Reaper launcher instead.";
const BLOCKED_WORKSPACE_MESSAGE =
  "Workspace switching is disabled inside an isolated IDE session. Use the Reaper launcher to change projects.";
const NON_PROJECT_EDITOR_SCHEMES = new Set(["walkThrough", "walkThroughSnippet", "gettingStarted"]);
const BUILTIN_COMMAND_OVERRIDES = [
  { id: "workbench.action.files.openFile", key: "open-file", message: BLOCKED_OPEN_FILE_MESSAGE },
  { id: "workbench.action.files.openFolder", key: "open-folder", message: BLOCKED_OPEN_FOLDER_MESSAGE },
  {
    id: "workbench.action.openWorkspaceFromFile",
    key: "open-workspace-file",
    message: BLOCKED_WORKSPACE_MESSAGE
  },
  {
    id: "workbench.action.openRecent",
    key: "open-recent",
    message: BLOCKED_WORKSPACE_MESSAGE
  },
  {
    id: "workbench.action.addRootFolder",
    key: "add-root-folder",
    message: BLOCKED_WORKSPACE_MESSAGE
  },
  {
    id: "workbench.action.saveWorkspaceAs",
    key: "save-workspace-as",
    message: BLOCKED_WORKSPACE_MESSAGE
  },
  {
    id: "workbench.action.closeFolder",
    key: "close-folder",
    message: BLOCKED_WORKSPACE_MESSAGE
  }
];

function normalizeFsPath(fsPath) {
  const resolved = path.resolve(String(fsPath || path.sep));
  if (resolved === path.sep) {
    return resolved;
  }

  return resolved.replace(/[\\/]+$/, "");
}

function isFileUri(uri) {
  return uri && uri.scheme === "file";
}

function isWithinRoot(targetPath, allowedRoot) {
  const normalizedTarget = normalizeFsPath(targetPath);
  const normalizedRoot = normalizeFsPath(allowedRoot);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

function basename(fsPath) {
  return path.basename(normalizeFsPath(fsPath));
}

class ReaperIdeGuard {
  constructor(context) {
    this.context = context;
    this.allowedRoot = "";
    this.syncingWorkspace = false;
    this.lastWarning = {
      key: "",
      timestamp: 0
    };
  }

  async activate() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    this.allowedRoot = workspaceFolder ? normalizeFsPath(workspaceFolder.uri.fsPath) : "";

    await vscode.commands.executeCommand("setContext", CONTEXT_KEY, Boolean(this.allowedRoot));

    if (!this.allowedRoot) {
      return;
    }

    this.context.subscriptions.push(
      vscode.commands.registerCommand("reaper.ideGuard.blockOpenFile", async () => {
        await this.showBoundaryWarning(BLOCKED_OPEN_FILE_MESSAGE, "open-file");
      }),
      vscode.commands.registerCommand("reaper.ideGuard.blockOpenFolder", async () => {
        await this.showBoundaryWarning(BLOCKED_OPEN_FOLDER_MESSAGE, "open-folder");
      }),
      vscode.commands.registerCommand("reaper.ideGuard.showProjectBoundary", async () => {
        await vscode.window.showInformationMessage(
          `Project boundary: ${basename(this.allowedRoot)} (${this.allowedRoot})`
        );
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.enforceWorkspaceBoundary();
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        void this.enforceDocumentBoundary(document);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        void this.enforceEditorBoundary(editor);
      })
    );

    for (const override of BUILTIN_COMMAND_OVERRIDES) {
      try {
        this.context.subscriptions.push(
          vscode.commands.registerCommand(override.id, async () => {
            await this.showBoundaryWarning(override.message, override.key);
          })
        );
      } catch (error) {
        void error;
      }
    }

    await this.enforceWorkspaceBoundary();
    await this.enforceVisibleEditors();
  }

  isBlockedUri(uri) {
    return isFileUri(uri) && !isWithinRoot(uri.fsPath, this.allowedRoot);
  }

  isDisposableEditorUri(uri) {
    if (!uri) {
      return false;
    }

    if (NON_PROJECT_EDITOR_SCHEMES.has(uri.scheme)) {
      return true;
    }

    const value = uri.toString().toLowerCase();
    return value.includes("gettingstarted") || value.includes("walkthrough");
  }

  async enforceWorkspaceBoundary() {
    if (!this.allowedRoot || this.syncingWorkspace) {
      return;
    }

    this.syncingWorkspace = true;
    try {
      let folders = vscode.workspace.workspaceFolders || [];
      const allowedRootUri = vscode.Uri.file(this.allowedRoot);
      const allowedRootName = basename(this.allowedRoot);
      const allowedFolderExists = folders.some(
        (folder) => normalizeFsPath(folder.uri.fsPath) === this.allowedRoot
      );

      if (!allowedFolderExists) {
        vscode.workspace.updateWorkspaceFolders(0, folders.length, {
          uri: allowedRootUri,
          name: allowedRootName
        });
        folders = vscode.workspace.workspaceFolders || [];
      }

      const removeIndexes = [];
      folders.forEach((folder, index) => {
        const folderPath = normalizeFsPath(folder.uri.fsPath);
        if (folderPath !== this.allowedRoot) {
          removeIndexes.push(index);
        }
      });

      for (let index = removeIndexes.length - 1; index >= 0; index -= 1) {
        vscode.workspace.updateWorkspaceFolders(removeIndexes[index], 1);
      }

      if (removeIndexes.length > 0) {
        await this.showBoundaryWarning(
          `This IDE session stays inside ${allowedRootName}. Extra folders were removed.`,
          "workspace-folder"
        );
      }
    } finally {
      this.syncingWorkspace = false;
    }
  }

  async enforceDocumentBoundary(document) {
    if (!document || !this.isBlockedUri(document.uri)) {
      return;
    }

    await this.closeVisibleEditorsForUri(document.uri);
    await this.showBoundaryWarning(
      `${path.basename(document.uri.fsPath)} is outside ${basename(this.allowedRoot)} and was closed.`,
      `document:${document.uri.toString()}`
    );
  }

  async enforceEditorBoundary(editor) {
    if (!editor?.document) {
      return;
    }

    if (this.isDisposableEditorUri(editor.document.uri)) {
      await this.closeEditor(editor);
      return;
    }

    if (!this.isBlockedUri(editor.document.uri)) {
      return;
    }

    await this.closeEditor(editor);
    await this.showBoundaryWarning(
      `${path.basename(editor.document.uri.fsPath)} is outside ${basename(this.allowedRoot)} and was closed.`,
      `editor:${editor.document.uri.toString()}`
    );
  }

  async enforceVisibleEditors() {
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.isDisposableEditorUri(editor.document.uri)) {
        await this.closeEditor(editor);
        continue;
      }

      if (!this.isBlockedUri(editor.document.uri)) {
        continue;
      }

      await this.closeEditor(editor);
      await this.showBoundaryWarning(
        `${path.basename(editor.document.uri.fsPath)} is outside ${basename(this.allowedRoot)} and was closed.`,
        `visible:${editor.document.uri.toString()}`
      );
    }
  }

  async closeVisibleEditorsForUri(targetUri) {
    const matchingEditors = vscode.window.visibleTextEditors.filter(
      (editor) => editor.document.uri.toString() === targetUri.toString()
    );

    for (const editor of matchingEditors) {
      await this.closeEditor(editor);
    }
  }

  async closeEditor(editor) {
    try {
      await vscode.window.showTextDocument(editor.document, {
        viewColumn: editor.viewColumn,
        preserveFocus: false,
        preview: true
      });
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } catch (error) {
      void error;
    }
  }

  async showBoundaryWarning(message, key) {
    const now = Date.now();
    if (this.lastWarning.key === key && now - this.lastWarning.timestamp < 3000) {
      return;
    }

    this.lastWarning = {
      key,
      timestamp: now
    };

    await vscode.window.showWarningMessage(message);
  }
}

function activate(context) {
  const guard = new ReaperIdeGuard(context);
  void guard.activate();
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
