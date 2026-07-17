import { basename, join } from "node:path";
import * as vscode from "vscode";
import {
  createReviewBaseContentProvider,
  createReviewBaseUri,
  REVIEW_BASE_SCHEME,
} from "./contentProvider";
import { createReviewDecorationProvider } from "./decorations";
import { createGit, Git } from "./git";
import { getGitApi, GitRepository } from "./gitExtensionApi";
import {
  computeReviewModel,
  FileReviewStatus,
  ReviewFile,
  ReviewModel,
} from "./model";
import {
  markReviewed,
  reviewRefForBranch,
  unmarkReviewed,
} from "./reviewState";
import {
  collapseKeyFor,
  ReviewTreeProvider,
  ReviewTreeElement,
  ViewMode,
} from "./treeProvider";

export const activate = async (
  context: vscode.ExtensionContext,
): Promise<void> => {
  let git: Git | undefined;
  let model: ReviewModel | undefined;

  // Group/folder collapse state, kept across refreshes and window reloads
  const collapsedKey = "deltaReview.collapsedGroups";
  const collapsed = new Set(
    context.workspaceState.get<string[]>(collapsedKey, []),
  );
  const persistCollapsed = (): void => {
    void context.workspaceState.update(collapsedKey, [...collapsed]);
  };

  // Flat list vs directory tree, mirroring the built-in CHANGES view toggle
  const viewModeKey = "deltaReview.viewMode";
  let viewMode = context.workspaceState.get<ViewMode>(viewModeKey, "list");
  void vscode.commands.executeCommand(
    "setContext",
    "deltaReview.viewMode",
    viewMode,
  );

  // Two persistence conventions share the collapsed set: default-expanded
  // elements (groups, folders) store their key while collapsed; default-
  // collapsed elements (Auto subgroups) store `expanded:<key>` while expanded,
  // so an absent key means collapsed.
  const treeProvider = new ReviewTreeProvider(
    (key, defaultCollapsed) =>
      defaultCollapsed ? !collapsed.has(`expanded:${key}`) : collapsed.has(key),
    () => viewMode,
  );
  const treeView = vscode.window.createTreeView("deltaReview", {
    treeDataProvider: treeProvider,
  });

  const setViewMode = (mode: ViewMode): void => {
    viewMode = mode;
    void context.workspaceState.update(viewModeKey, mode);
    void vscode.commands.executeCommand(
      "setContext",
      "deltaReview.viewMode",
      mode,
    );
    treeProvider.refresh();
  };

  context.subscriptions.push(
    treeView.onDidCollapseElement((event) => {
      if (event.element.kind === "file") {
        return;
      }
      if (event.element.kind === "autoGroup") {
        collapsed.delete(`expanded:${collapseKeyFor(event.element)}`);
      } else {
        collapsed.add(collapseKeyFor(event.element));
      }
      persistCollapsed();
    }),
    treeView.onDidExpandElement((event) => {
      if (event.element.kind === "file") {
        return;
      }
      if (event.element.kind === "autoGroup") {
        collapsed.add(`expanded:${collapseKeyFor(event.element)}`);
      } else {
        collapsed.delete(collapseKeyFor(event.element));
      }
      persistCollapsed();
    }),
    vscode.commands.registerCommand("deltaReview.viewAsTree", () =>
      setViewMode("tree"),
    ),
    vscode.commands.registerCommand("deltaReview.viewAsList", () =>
      setViewMode("list"),
    ),
  );

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  statusBarItem.command = "deltaReview.focus";

  context.subscriptions.push(
    treeView,
    statusBarItem,
    vscode.workspace.registerTextDocumentContentProvider(
      REVIEW_BASE_SCHEME,
      createReviewBaseContentProvider(() => git),
    ),
    vscode.window.registerFileDecorationProvider(
      createReviewDecorationProvider(),
    ),
  );

  // Refreshes run concurrently (watcher bursts, repo switches); the generation
  // counter keeps a slow, older computation from overwriting a newer result
  let refreshGeneration = 0;
  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration;
    if (git === undefined) {
      model = undefined;
      treeProvider.setModel(undefined);
      treeView.badge = undefined;
      treeView.message =
        "Open a folder inside a git repository to start reviewing.";
      statusBarItem.hide();
      return;
    }
    const configuration = vscode.workspace.getConfiguration("deltaReview");
    const baseBranch = configuration.get<string>("baseBranch") ?? "main";
    const autoReviewGlobs =
      configuration.get<string[]>("autoReview.globs") ?? [];
    try {
      let computed = await computeReviewModel(git, baseBranch, {
        autoReviewGlobs,
      });
      if (generation !== refreshGeneration) {
        return;
      }
      // Auto-marking goes through the normal snapshot path (markReviewed), so
      // a later edit to an auto-marked file resurfaces as a needs-review delta.
      // It runs before setModel so the tree never flashes "needs review" for
      // files about to be auto-marked. The ref write may trigger another
      // refresh via the repo watcher; that one finds nothing left to mark.
      if (configuration.get<boolean>("autoReview.markAutomatically") === true) {
        const autoPaths = computed.files
          .filter(
            (file) =>
              file.triage === "auto" &&
              file.status === FileReviewStatus.NeedsReview,
          )
          .map((file) => file.path);
        if (autoPaths.length > 0) {
          await markReviewed(git, computed.branch, autoPaths);
          if (generation !== refreshGeneration) {
            return;
          }
          computed = await computeReviewModel(git, baseBranch, {
            autoReviewGlobs,
          });
          if (generation !== refreshGeneration) {
            return;
          }
        }
      }
      model = computed;
      treeProvider.setModel(model);
      treeView.message = undefined;

      const reviewedCount = model.files.filter(
        (file) => file.status === FileReviewStatus.Reviewed,
      ).length;
      const needsReviewCount = model.files.length - reviewedCount;
      treeView.badge =
        needsReviewCount > 0
          ? {
              value: needsReviewCount,
              tooltip: `${needsReviewCount} file${needsReviewCount === 1 ? "" : "s"} to review`,
            }
          : undefined;
      statusBarItem.text = `$(checklist) Review ${reviewedCount}/${model.files.length}`;
      statusBarItem.tooltip = `Delta Review: ${model.branch} vs ${baseBranch}`;
      statusBarItem.show();
    } catch (error) {
      if (generation !== refreshGeneration) {
        return;
      }
      model = undefined;
      treeProvider.setModel(undefined);
      treeView.badge = undefined;
      treeView.message = `Delta Review: ${error instanceof Error ? error.message : String(error)}`;
      statusBarItem.hide();
    }
  };

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => void refresh(), 400);
  };

  // The active repo can live outside the workspace folders (e.g. a sibling
  // worktree selected in the Source Control view), so the watcher is scoped
  // to the repo root rather than the workspace
  let repoWatcherDisposables: vscode.Disposable[] = [];
  const disposeRepoWatcher = (): void => {
    for (const disposable of repoWatcherDisposables) {
      disposable.dispose();
    }
    repoWatcherDisposables = [];
  };
  const watchRepo = (repoRoot: string): void => {
    disposeRepoWatcher();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(repoRoot), "**/*"),
    );
    repoWatcherDisposables = [
      watcher,
      watcher.onDidChange(scheduleRefresh),
      watcher.onDidCreate(scheduleRefresh),
      watcher.onDidDelete(scheduleRefresh),
    ];
  };
  context.subscriptions.push(new vscode.Disposable(disposeRepoWatcher));

  const setActiveRepo = async (repoRoot: string | undefined): Promise<void> => {
    if (repoRoot === git?.repoRoot) {
      return;
    }
    if (repoRoot === undefined) {
      git = undefined;
      disposeRepoWatcher();
    } else {
      git = createGit(repoRoot);
      watchRepo(repoRoot);
    }
    await refresh();
  };

  const openDiff = async (file: ReviewFile): Promise<void> => {
    if (git === undefined) {
      return;
    }
    const leftUri = createReviewBaseUri(file.path, file.diffBaseSha);
    const rightUri = file.deleted
      ? createReviewBaseUri(file.path, undefined)
      : vscode.Uri.file(join(git.repoRoot, file.path));
    const baseLabel = file.diffBaseIsReviewedSnapshot
      ? "last reviewed"
      : "merge base";
    const workingLabel = file.deleted ? "deleted" : "working tree";
    const title = `${basename(file.path)} (${baseLabel} ↔ ${workingLabel})`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      title,
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("deltaReview.refresh", () => refresh()),

    vscode.commands.registerCommand(
      "deltaReview.markFileReviewed",
      async (element?: ReviewTreeElement) => {
        if (
          git === undefined ||
          model === undefined ||
          element?.kind !== "file"
        ) {
          return;
        }
        await markReviewed(git, model.branch, [element.file.path]);
        await refresh();
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.unmarkFileReviewed",
      async (element?: ReviewTreeElement) => {
        if (
          git === undefined ||
          model === undefined ||
          element?.kind !== "file"
        ) {
          return;
        }
        await unmarkReviewed(git, model.branch, [element.file.path]);
        await refresh();
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.unmarkAllReviewed",
      async () => {
        if (git === undefined || model === undefined) {
          return;
        }
        const paths = model.files
          .filter((file) => file.status === FileReviewStatus.Reviewed)
          .map((file) => file.path);
        if (paths.length === 0) {
          return;
        }
        await unmarkReviewed(git, model.branch, paths);
        await refresh();
      },
    ),
    vscode.commands.registerCommand("deltaReview.openDiff", openDiff),

    vscode.commands.registerCommand(
      "deltaReview.openFile",
      async (element?: ReviewTreeElement) => {
        if (
          git === undefined ||
          element === undefined ||
          element.kind !== "file" ||
          element.file.deleted
        ) {
          return;
        }
        await vscode.window.showTextDocument(
          vscode.Uri.file(join(git.repoRoot, element.file.path)),
        );
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.markFolderReviewed",
      async (element?: ReviewTreeElement) => {
        if (
          git === undefined ||
          model === undefined ||
          element?.kind !== "folder"
        ) {
          return;
        }
        const paths = model.files
          .filter(
            (file) =>
              file.triage === "normal" &&
              file.status === FileReviewStatus.NeedsReview &&
              file.path.startsWith(`${element.path}/`),
          )
          .map((file) => file.path);
        if (paths.length === 0) {
          return;
        }
        await markReviewed(git, model.branch, paths);
        await refresh();
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.unmarkFolderReviewed",
      async (element?: ReviewTreeElement) => {
        if (
          git === undefined ||
          model === undefined ||
          element?.kind !== "folder"
        ) {
          return;
        }
        const paths = model.files
          .filter(
            (file) =>
              file.triage === "normal" &&
              file.status === FileReviewStatus.Reviewed &&
              file.path.startsWith(`${element.path}/`),
          )
          .map((file) => file.path);
        if (paths.length === 0) {
          return;
        }
        await unmarkReviewed(git, model.branch, paths);
        await refresh();
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.markAutoReviewed",
      async (element?: ReviewTreeElement) => {
        if (
          git === undefined ||
          model === undefined ||
          element?.kind !== "autoGroup"
        ) {
          return;
        }
        const paths = model.files
          .filter(
            (file) =>
              file.triage === "auto" &&
              file.status === FileReviewStatus.NeedsReview,
          )
          .map((file) => file.path);
        if (paths.length === 0) {
          return;
        }
        await markReviewed(git, model.branch, paths);
        await refresh();
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.unmarkAutoReviewed",
      async (element?: ReviewTreeElement) => {
        if (
          git === undefined ||
          model === undefined ||
          element?.kind !== "autoGroup"
        ) {
          return;
        }
        const paths = model.files
          .filter(
            (file) =>
              file.triage === "auto" &&
              file.status === FileReviewStatus.Reviewed,
          )
          .map((file) => file.path);
        if (paths.length === 0) {
          return;
        }
        await unmarkReviewed(git, model.branch, paths);
        await refresh();
      },
    ),

    vscode.commands.registerCommand("deltaReview.markAllReviewed", async () => {
      if (git === undefined || model === undefined) {
        return;
      }
      const paths = model.files
        .filter((file) => file.status === FileReviewStatus.NeedsReview)
        .map((file) => file.path);
      if (paths.length === 0) {
        return;
      }
      await markReviewed(git, model.branch, paths);
      await refresh();
    }),

    vscode.commands.registerCommand(
      "deltaReview.clearReviewState",
      async () => {
        if (git === undefined || model === undefined) {
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `Clear all review state for branch "${model.branch}"?`,
          { modal: true },
          "Clear",
        );
        if (choice !== "Clear") {
          return;
        }
        try {
          await git.run(["update-ref", "-d", reviewRefForBranch(model.branch)]);
        } catch {
          // Ref did not exist — nothing to clear
        }
        await refresh();
      },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("deltaReview")) {
        scheduleRefresh();
      }
    }),
  );

  const gitApi = await getGitApi();
  if (gitApi !== undefined) {
    // Follow the repository selected in the Source Control view — switching
    // to another repo or worktree there retargets the review set, mirroring
    // what the built-in CHANGES panel does
    const repoListeners = new Map<GitRepository, vscode.Disposable[]>();
    const syncActiveRepo = (): void => {
      const repositories = gitApi.repositories;
      const active =
        repositories.find((repo) => repo.ui.selected) ?? repositories[0];
      treeView.description =
        repositories.length > 1 && active !== undefined
          ? basename(active.rootUri.fsPath)
          : undefined;
      void setActiveRepo(active?.rootUri.fsPath);
    };
    const trackRepository = (repository: GitRepository): void => {
      repoListeners.set(repository, [
        repository.ui.onDidChange(syncActiveRepo),
        // HEAD/index/ref changes (branch switch, commit, fetch) live outside
        // the worktree in linked worktrees, so the file watcher misses them
        repository.state.onDidChange(() => {
          if (repository.rootUri.fsPath === git?.repoRoot) {
            scheduleRefresh();
          }
        }),
      ]);
      syncActiveRepo();
    };
    gitApi.repositories.forEach(trackRepository);
    context.subscriptions.push(
      gitApi.onDidOpenRepository(trackRepository),
      gitApi.onDidCloseRepository((repository) => {
        for (const disposable of repoListeners.get(repository) ?? []) {
          disposable.dispose();
        }
        repoListeners.delete(repository);
        syncActiveRepo();
      }),
      new vscode.Disposable(() => {
        for (const disposables of repoListeners.values()) {
          for (const disposable of disposables) {
            disposable.dispose();
          }
        }
      }),
    );
  } else {
    // Built-in git extension unavailable — fall back to the repo containing
    // the first workspace folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder !== undefined) {
      try {
        const candidate = createGit(workspaceFolder.uri.fsPath);
        const repoRoot = (
          await candidate.run(["rev-parse", "--show-toplevel"])
        ).trim();
        await setActiveRepo(repoRoot);
      } catch {
        // Not a git repository
      }
    }
  }

  await refresh();
};
