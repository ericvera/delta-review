import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import {
  ClusterModel,
  clusterFilesForKey,
  loadClustersContract,
  resolveClusterModel,
} from "./clusters";
import {
  baseBlobForPath,
  createNoteCommentController,
} from "./commentController";
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
import { mergeThreads } from "./noteThreads";
import { loadNotes, loadResponses, refreshDerived } from "./notesStore";
import {
  markReviewed,
  reviewRefForBranch,
  unmarkReviewed,
} from "./reviewState";
import {
  collapseKeyFor,
  isDefaultCollapsed,
  ReviewTreeProvider,
  ReviewTreeElement,
  ViewMode,
} from "./treeProvider";

// Dedupes the non-fatal notes-refresh warning across watcher-triggered
// refreshes (same pattern the response-file warning will use)
let lastNotesWarning: string | undefined;

export const activate = async (
  context: vscode.ExtensionContext,
): Promise<void> => {
  let git: Git | undefined;
  let model: ReviewModel | undefined;
  let clusterModel: ClusterModel | undefined;

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

  // Cluster grouping lever (clusters on ⇄ off). The stored preference
  // survives a vanished or invalid contract: effective grouping is
  // `groupedPreference && clusterModel !== undefined`, so the view falls back
  // to ungrouped without erasing the user's choice.
  const groupedKey = "deltaReview.grouped";
  let groupedPreference = context.workspaceState.get<boolean>(
    groupedKey,
    false,
  );
  void vscode.commands.executeCommand(
    "setContext",
    "deltaReview.grouped",
    groupedPreference,
  );
  // The grouping button only exists while a valid contract exists
  const setClustersAvailable = (available: boolean): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "deltaReview.clustersAvailable",
      available,
    );
  };
  setClustersAvailable(false);

  // Two persistence conventions share the collapsed set: default-expanded
  // elements (groups, clusters, folders) store their key while collapsed;
  // default-collapsed elements (Auto in either placement) store
  // `expanded:<key>` while expanded, so an absent key means collapsed.
  const treeProvider = new ReviewTreeProvider(
    (key, defaultCollapsed) =>
      defaultCollapsed ? !collapsed.has(`expanded:${key}`) : collapsed.has(key),
    () => viewMode,
    () => clusterModel,
    // Effective grouping: the preference only takes effect while a valid
    // contract produced a cluster model
    () => groupedPreference && clusterModel !== undefined,
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

  const setGrouped = (grouped: boolean): void => {
    groupedPreference = grouped;
    void context.workspaceState.update(groupedKey, grouped);
    void vscode.commands.executeCommand(
      "setContext",
      "deltaReview.grouped",
      grouped,
    );
    treeProvider.refresh();
  };

  context.subscriptions.push(
    treeView.onDidCollapseElement((event) => {
      const element = event.element;
      if (element.kind === "file" || element.kind === "message") {
        return;
      }
      if (isDefaultCollapsed(element)) {
        collapsed.delete(`expanded:${collapseKeyFor(element)}`);
      } else {
        collapsed.add(collapseKeyFor(element));
      }
      persistCollapsed();
    }),
    treeView.onDidExpandElement((event) => {
      const element = event.element;
      if (element.kind === "file" || element.kind === "message") {
        return;
      }
      if (isDefaultCollapsed(element)) {
        collapsed.add(`expanded:${collapseKeyFor(element)}`);
      } else {
        collapsed.delete(collapseKeyFor(element));
      }
      persistCollapsed();
    }),
    vscode.commands.registerCommand("deltaReview.viewAsTree", () =>
      setViewMode("tree"),
    ),
    vscode.commands.registerCommand("deltaReview.viewAsList", () =>
      setViewMode("list"),
    ),
    vscode.commands.registerCommand("deltaReview.groupByCluster", () =>
      setGrouped(true),
    ),
    vscode.commands.registerCommand("deltaReview.ungroupClusters", () =>
      setGrouped(false),
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

  // Inline review-note threads in the diff editor. onDidChangeNotes runs a
  // full refresh so a freshly saved note immediately goes through the same
  // derived-field pass as any other note.
  const commentController = createNoteCommentController(
    () => git,
    () => model,
    () => void refresh(),
  );
  context.subscriptions.push(commentController);

  // Refreshes run concurrently (watcher bursts, repo switches); the generation
  // counter keeps a slow, older computation from overwriting a newer result
  let refreshGeneration = 0;
  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration;
    if (git === undefined) {
      model = undefined;
      clusterModel = undefined;
      setClustersAvailable(false);
      treeProvider.setModel(undefined);
      treeView.badge = undefined;
      treeView.message =
        "Open a folder inside a git repository to start reviewing.";
      statusBarItem.hide();
      commentController.renderThreads([]);
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
      // Clusters contract, reloaded on every refresh so correctness never
      // depends on watcher delivery. Missing is normal (no warning); invalid
      // surfaces a warning but otherwise behaves as missing. A branch switch
      // is covered too: `computed.branch` selects the contract file.
      const contractResult = await loadClustersContract(git, computed.branch);
      if (generation !== refreshGeneration) {
        return;
      }
      let contractWarning: string | undefined;
      if (contractResult.state === "ok") {
        clusterModel = resolveClusterModel(
          contractResult.contract,
          computed.files,
        );
      } else {
        clusterModel = undefined;
        if (contractResult.state === "invalid") {
          contractWarning = `⚠ Clusters contract: ${contractResult.error}`;
        }
      }
      setClustersAvailable(clusterModel !== undefined);

      model = computed;
      treeProvider.setModel(model);
      treeView.message = contractWarning;

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

      // Review-note threads: load, refresh derived positions against the
      // current documents, and render. The store never creates a notes file
      // here — with no notes on disk there is nothing to refresh. Notes are
      // a layer on top of the review model, so a notes failure (e.g. an
      // unwritable .git/delta-review during refreshDerived's persistence)
      // must not tear down the already-rendered tree: this block has its own
      // catch that leaves the model, tree, status bar, and any previously
      // rendered threads intact and only surfaces a deduped warning.
      try {
        const gitForNotes = git;
        const notesResult = await loadNotes(gitForNotes, computed.branch);
        if (generation !== refreshGeneration) {
          return;
        }
        if (notesResult.state === "ok" && notesResult.file.notes.length > 0) {
          const responsesResult = await loadResponses(
            gitForNotes,
            computed.branch,
          );
          if (generation !== refreshGeneration) {
            return;
          }
          const responses =
            responsesResult.state === "ok" ? responsesResult.file : undefined;
          const refreshed = await refreshDerived(
            gitForNotes,
            computed.branch,
            notesResult.file,
            responses,
            {
              readWorkingContent: async (path) => {
                try {
                  return await readFile(
                    join(gitForNotes.repoRoot, path),
                    "utf8",
                  );
                } catch {
                  return undefined;
                }
              },
              baseBlobFor: (path) => baseBlobForPath(computed, path),
              // Response-anchor resolution lands with the agent-response
              // flow; until then every anchor is treated as dangling
              anchorResolves: () => false,
            },
          );
          if (generation !== refreshGeneration) {
            return;
          }
          commentController.renderThreads(
            mergeThreads(refreshed, responses, () => false),
          );
        } else if (notesResult.state !== "invalid") {
          // Missing or empty — clear any rendered threads. An invalid file
          // leaves the display untouched (the store refuses to overwrite it).
          commentController.renderThreads([]);
        }
      } catch (notesError) {
        if (generation !== refreshGeneration) {
          return;
        }
        // Watcher bursts re-run refresh constantly; identical failures warn
        // once until the message changes
        const warning = `Delta Review: review notes refresh failed (${notesError instanceof Error ? notesError.message : String(notesError)})`;
        if (warning !== lastNotesWarning) {
          lastNotesWarning = warning;
          void vscode.window.showWarningMessage(warning);
        }
      }
    } catch (error) {
      if (generation !== refreshGeneration) {
        return;
      }
      model = undefined;
      clusterModel = undefined;
      setClustersAvailable(false);
      treeProvider.setModel(undefined);
      treeView.badge = undefined;
      // Fatal model errors win over any contract warning
      treeView.message = `Delta Review: ${error instanceof Error ? error.message : String(error)}`;
      statusBarItem.hide();
      commentController.renderThreads([]);
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
  // The clusters contract lives under the git common dir — event delivery for
  // `.git` paths through the repo-root watcher is not guaranteed, and for a
  // linked worktree the common dir is outside repoRoot entirely — so it gets
  // its own directory-scoped watcher. The directory may not exist yet; events
  // fire once it is created. The per-refresh contract re-read keeps behavior
  // correct even if watcher events are missed.
  const watchContractDir = async (gitInstance: Git): Promise<void> => {
    let contractDir: string;
    try {
      const commonDirOutput = (
        await gitInstance.run(["rev-parse", "--git-common-dir"])
      ).trim();
      contractDir = join(
        isAbsolute(commonDirOutput)
          ? commonDirOutput
          : join(gitInstance.repoRoot, commonDirOutput),
        "delta-review",
      );
    } catch {
      return;
    }
    if (git !== gitInstance) {
      // The active repo changed while the common dir was being resolved
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(contractDir), "*.json"),
    );
    repoWatcherDisposables.push(
      watcher,
      watcher.onDidChange(scheduleRefresh),
      watcher.onDidCreate(scheduleRefresh),
      watcher.onDidDelete(scheduleRefresh),
    );
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
      void watchContractDir(git);
    }
    await refresh();
  };

  const openDiff = async (file: ReviewFile): Promise<void> => {
    if (git === undefined) {
      return;
    }
    // For a move diffed against the merge base, the base blob came from the
    // old path — label the left editor with it. A reviewed snapshot was
    // captured from the new path, so it keeps the new path.
    const leftPath = file.diffBaseIsReviewedSnapshot
      ? file.path
      : (file.movedFrom ?? file.path);
    const leftUri = createReviewBaseUri(leftPath, file.diffBaseSha);
    const rightUri = file.deleted
      ? createReviewBaseUri(file.path, undefined)
      : vscode.Uri.file(join(git.repoRoot, file.path));
    const baseLabel = file.diffBaseIsReviewedSnapshot
      ? "last reviewed"
      : "merge base";
    const workingLabel = file.deleted ? "deleted" : "working tree";
    const title =
      file.movedFrom === undefined
        ? `${basename(file.path)} (${baseLabel} ↔ ${workingLabel})`
        : `${basename(file.path)} (moved from ${file.movedFrom} — ${baseLabel} ↔ ${workingLabel})`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      title,
    );
  };

  // The visible file set a folder row subdivides: all files when scoped to
  // the grouped Reviewed bucket, its cluster's files when cluster-scoped
  // (grouped view), otherwise the model's non-auto files. Folder bulk actions
  // must cover the folder's *visible* children: auto files render inline in
  // the Reviewed bucket (so they're covered there) but in the Auto bucket
  // elsewhere (so they're excluded elsewhere).
  const folderScopeFiles = (element: {
    clusterKey?: string;
    inReviewedBucket?: true;
  }): ReviewFile[] => {
    if (element.inReviewedBucket === true) {
      return model?.files ?? [];
    }
    if (element.clusterKey !== undefined) {
      return clusterModel === undefined
        ? []
        : clusterFilesForKey(clusterModel, element.clusterKey);
    }
    return (model?.files ?? []).filter((file) => file.triage === "normal");
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("deltaReview.refresh", () => refresh()),

    vscode.commands.registerCommand(
      "deltaReview.addNote",
      (reply: vscode.CommentReply) => commentController.addNote(reply),
    ),

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
        const paths = folderScopeFiles(element)
          .filter(
            (file) =>
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
        const paths = folderScopeFiles(element)
          .filter(
            (file) =>
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
      "deltaReview.markClusterReviewed",
      async (element?: ReviewTreeElement) => {
        if (
          git === undefined ||
          model === undefined ||
          clusterModel === undefined ||
          element?.kind !== "cluster"
        ) {
          return;
        }
        const paths = clusterFilesForKey(clusterModel, element.clusterKey)
          .filter((file) => file.status === FileReviewStatus.NeedsReview)
          .map((file) => file.path);
        if (paths.length === 0) {
          return;
        }
        await markReviewed(git, model.branch, paths);
        await refresh();
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.unmarkClusterReviewed",
      async (element?: ReviewTreeElement) => {
        if (
          git === undefined ||
          model === undefined ||
          clusterModel === undefined ||
          element?.kind !== "cluster"
        ) {
          return;
        }
        const paths = clusterFilesForKey(clusterModel, element.clusterKey)
          .filter((file) => file.status === FileReviewStatus.Reviewed)
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
