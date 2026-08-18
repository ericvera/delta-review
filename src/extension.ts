import { access, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import { baseBlobForNote } from "./baseDocument";
import {
  ClusterModel,
  clusterFilesForKey,
  loadClustersContract,
  resolveClusterModel,
} from "./clusters";
import { createNoteCommentController } from "./commentController";
import {
  createReviewBaseContentProvider,
  createReviewBaseUri,
  REVIEW_BASE_SCHEME,
} from "./contentProvider";
import { createReviewDecorationProvider } from "./decorations";
import { createGit, Git } from "./git";
import { getGitApi, GitRepository } from "./gitExtensionApi";
import type { HashCacheEntry } from "./hashCache";
import {
  computeReviewModel,
  FileReviewStatus,
  resolveBranch,
  ReviewFile,
  ReviewModel,
} from "./model";
import type { ResponsesFile } from "./notes";
import {
  noteAnchorLines,
  noteTargetFor,
  reviewDiffIsEmpty,
} from "./noteTarget";
import { mergeThreads, NoteThread } from "./noteThreads";
import {
  notesCollapseKeyFor,
  NotesTreeElement,
  NotesTreeProvider,
} from "./notesTreeProvider";
import {
  buildAnchorResolver,
  deleteNote,
  deleteNotes,
  loadNotes,
  loadResponses,
  refreshDerived,
  setResolved,
} from "./notesStore";
import {
  markReviewed,
  reviewRefForBranch,
  unmarkReviewed,
} from "./reviewState";
import { createSerialQueue } from "./serialQueue";
import { fileElementFor } from "./treeParents";
import {
  collapseKeyFor,
  isDefaultCollapsed,
  ReviewTreeProvider,
  ReviewTreeElement,
  ViewMode,
} from "./treeProvider";

// Dedupes the non-fatal notes-refresh warning across watcher-triggered
// refreshes: identical failures warn once until the message changes. The
// notes-file and responses-file warnings follow the same pattern, each with
// its own last-warned string (reset when its file loads cleanly, so a
// recurrence after a fix warns again).
let lastNotesWarning: string | undefined;
let lastNotesFileWarning: string | undefined;
let lastResponsesFileWarning: string | undefined;

const warnOnce = (lastWarned: string | undefined, warning: string): string => {
  if (warning !== lastWarned) {
    void vscode.window.showWarningMessage(warning);
  }
  return warning;
};

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

  // REVIEW NOTES: sibling SCM section below the review set. File groups
  // default to expanded, so they use the bare-key-while-collapsed convention
  // of the shared collapsed set (keys namespaced `notes:<path>`).
  const notesTreeProvider = new NotesTreeProvider((key) => collapsed.has(key));
  const notesTreeView = vscode.window.createTreeView("deltaReviewNotes", {
    treeDataProvider: notesTreeProvider,
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
    notesTreeView.onDidCollapseElement((event) => {
      if (event.element.kind === "fileGroup") {
        collapsed.add(notesCollapseKeyFor(event.element));
        persistCollapsed();
      }
    }),
    notesTreeView.onDidExpandElement((event) => {
      if (event.element.kind === "fileGroup") {
        collapsed.delete(notesCollapseKeyFor(event.element));
        persistCollapsed();
      }
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
    notesTreeView,
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

  // The currently rendered thread set — what Clear Resolved operates on.
  // Only renderNoteThreads assigns it, so it always matches both surfaces.
  let currentNoteThreads: NoteThread[] = [];

  // Renders the merged threads into both notes surfaces: the inline comment
  // threads and the REVIEW NOTES tree (with its to-handle badge). Every call
  // site is generation-guarded inside refresh(), so the two surfaces always
  // show the same thread set.
  const renderNoteThreads = (threads: NoteThread[]): void => {
    currentNoteThreads = threads;
    commentController.renderThreads(threads);
    notesTreeProvider.setThreads(threads);
    // Open + addressed need reviewer attention; resolved notes are done
    const toHandle = threads.filter(
      (thread) => thread.status !== "resolved",
    ).length;
    notesTreeView.badge =
      toHandle > 0
        ? {
            value: toHandle,
            tooltip: `${toHandle} review note${toHandle === 1 ? "" : "s"} to handle`,
          }
        : undefined;
  };

  // Refreshes run concurrently (watcher bursts, repo switches); the generation
  // counter keeps a slow, older computation from overwriting a newer result
  let refreshGeneration = 0;
  // Every write to refs/review/<branch> — user commands and the auto-mark
  // pass below — goes through this one queue. Each mutation is a read of the
  // ref, a change, then a write; two of them overlapping lose one side's
  // paths. Only the mutation is queued: refresh() itself must never run
  // inside it, since the auto-mark pass enqueues from within refresh() and
  // would deadlock behind a slot the caller is still holding.
  const reviewStateQueue = createSerialQueue();
  // Working-tree content shas kept across refreshes so a refresh only hashes
  // the files that actually moved. Entries are validated by size and mtime, so
  // a branch switch needs no invalidation (content identity is not
  // branch-scoped) — a repo switch does, and clears it in setActiveRepo.
  const hashCache = new Map<string, HashCacheEntry>();
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
      renderNoteThreads([]);
      return;
    }
    const configuration = vscode.workspace.getConfiguration("deltaReview");
    const baseBranch = configuration.get<string>("baseBranch") ?? "main";
    const autoReviewGlobs =
      configuration.get<string[]>("autoReview.globs") ?? [];
    try {
      // The branch, then the clusters contract, are resolved before anything
      // is computed: the contract's move declarations feed the review model,
      // so they have to be in hand first. Both git calls stay inside this try
      // so an unborn HEAD or a repo torn down mid-refresh reaches the fatal
      // banner below rather than becoming an unhandled rejection.
      const branch = await resolveBranch(git);
      if (generation !== refreshGeneration) {
        return;
      }
      // Loaded once per refresh, so correctness never depends on watcher
      // delivery, and re-applied to every computation below — a contract
      // rewritten mid-refresh cannot yield a model whose moves and clusters
      // disagree. Missing is normal (no warning); invalid warns but otherwise
      // behaves as missing, taking its move declarations down with it.
      const contractResult = await loadClustersContract(git, branch);
      if (generation !== refreshGeneration) {
        return;
      }
      const moves =
        contractResult.state === "ok" ? contractResult.contract.moves : [];
      let computed = await computeReviewModel(git, baseBranch, {
        autoReviewGlobs,
        branch,
        moves,
        hashCache,
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
          const gitForAutoMark = git;
          const autoBranch = computed.branch;
          await reviewStateQueue.run(() =>
            markReviewed(gitForAutoMark, autoBranch, autoPaths),
          );
          if (generation !== refreshGeneration) {
            return;
          }
          // Same cache instance as the computation above: the auto-mark pass
          // changes the ref, not the working tree, so this recomputation
          // re-hashes nothing
          computed = await computeReviewModel(git, baseBranch, {
            autoReviewGlobs,
            branch,
            moves,
            hashCache,
          });
          if (generation !== refreshGeneration) {
            return;
          }
        }
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
        const readWorkingContent = async (
          path: string,
        ): Promise<string | undefined> => {
          try {
            return await readFile(join(gitForNotes.repoRoot, path), "utf8");
          } catch {
            return undefined;
          }
        };
        const notesResult = await loadNotes(gitForNotes, computed.branch);
        if (generation !== refreshGeneration) {
          return;
        }
        if (notesResult.state === "invalid") {
          // An invalid notes file is read-only broken: warn, render nothing,
          // and never rewrite the file. Mutation attempts surface their own
          // toast — the store refuses to overwrite an invalid file.
          lastNotesFileWarning = warnOnce(
            lastNotesFileWarning,
            `Delta Review: review notes file: ${notesResult.error} — notes are read-only until the file is fixed`,
          );
          renderNoteThreads([]);
          return;
        }
        lastNotesFileWarning = undefined;
        // The responses file is validated regardless of note count: an
        // invalid file warns (deduped) even with no notes on disk — only a
        // missing responses file is the silent normal state
        const responsesResult = await loadResponses(
          gitForNotes,
          computed.branch,
        );
        if (generation !== refreshGeneration) {
          return;
        }
        let responses: ResponsesFile | undefined;
        if (responsesResult.state === "invalid") {
          // Invalid responses file: non-fatal — warn and behave as missing
          lastResponsesFileWarning = warnOnce(
            lastResponsesFileWarning,
            `Delta Review: review notes responses: ${responsesResult.error}`,
          );
        } else {
          // Missing is the normal state (no agent has responded) — silent
          lastResponsesFileWarning = undefined;
          responses =
            responsesResult.state === "ok" ? responsesResult.file : undefined;
        }
        if (notesResult.state === "ok" && notesResult.file.notes.length > 0) {
          // Anchor resolution runs against the working tree once per refresh;
          // the same resolver drives anchor application (refreshDerived) and
          // the rendered merge, so both see identical effective anchors
          const anchorResolves = await buildAnchorResolver(
            responses,
            readWorkingContent,
          );
          const refreshed = await refreshDerived(
            gitForNotes,
            computed.branch,
            notesResult.file,
            responses,
            {
              readWorkingContent,
              baseBlobFor: (path, contentBlob) =>
                baseBlobForNote(computed, path, contentBlob),
              anchorResolves,
            },
          );
          if (generation !== refreshGeneration) {
            return;
          }
          renderNoteThreads(mergeThreads(refreshed, responses, anchorResolves));
        } else {
          // Missing or empty — clear any rendered threads
          renderNoteThreads([]);
        }
      } catch (notesError) {
        if (generation !== refreshGeneration) {
          return;
        }
        // Watcher bursts re-run refresh constantly; identical failures warn
        // once until the message changes
        lastNotesWarning = warnOnce(
          lastNotesWarning,
          `Delta Review: review notes refresh failed (${notesError instanceof Error ? notesError.message : String(notesError)})`,
        );
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
      renderNoteThreads([]);
    }
  };

  // Command-side wrapper for a review-state mutation: serialize the write,
  // then refresh outside the queue. A failure anywhere (the git write or the
  // refresh that follows) is the user's click going nowhere, so it always
  // becomes a visible error rather than a rejected command promise. The view's
  // built-in progress bar covers the whole thing — queue wait included — so a
  // click issued while another mark is still running reads as busy rather than
  // as dead.
  const applyReviewStateChange = async (
    action: string,
    mutate: () => Promise<void>,
  ): Promise<void> =>
    vscode.window.withProgress(
      { location: { viewId: "deltaReview" } },
      async () => {
        try {
          await reviewStateQueue.run(mutate);
          await refresh();
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Delta Review: failed to ${action} (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      },
    );

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
    // Cached hashes are keyed by repo-relative path, so they mean nothing in
    // another checkout
    hashCache.clear();
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

  const openDiff = async (
    file: ReviewFile,
    selection?: vscode.Range,
  ): Promise<void> => {
    if (git === undefined) {
      return;
    }
    // The path identifying the base document the model actually resolved: a
    // repo origin's old path when the base really is that origin's blob, the
    // file's own path otherwise. Always repo-relative, so a declared external
    // origin can never escape the repo through a base-document URI.
    const leftUri = createReviewBaseUri(file.diffBasePath, file.diffBaseSha);
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
    // The TextDocumentShowOptions must be the positional 4th argument —
    // folding it into the title silently breaks the command
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      title,
      selection === undefined ? undefined : { selection },
    );
  };

  // Selection sync from REVIEW NOTES: put the noted file's row in DELTA
  // REVIEW, expanding whatever ancestors are collapsed. Best effort — reveal
  // rejects on a view that cannot be shown, and that must never fail the
  // click that triggered it.
  const revealFileRow = async (file: ReviewFile): Promise<void> => {
    const element = fileElementFor(file, {
      clusterModel,
      viewMode,
      grouped: groupedPreference && clusterModel !== undefined,
    });
    try {
      await treeView.reveal(element, { select: true, focus: false });
    } catch (error) {
      console.warn("Delta Review: could not reveal file row", error);
    }
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

  // REVIEW NOTES row resolve/unresolve. Straight to the store, never through
  // the comment controller: a note whose file is gone has no rendered thread
  // to act on, and the row is the only affordance left.
  const setNoteRowResolved = async (
    element: NotesTreeElement | undefined,
    resolved: boolean,
  ): Promise<void> => {
    if (git === undefined || model === undefined || element?.kind !== "note") {
      return;
    }
    try {
      await setResolved(git, model.branch, element.thread.note.id, resolved);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Delta Review: failed to ${resolved ? "resolve" : "unresolve"} note (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    await refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("deltaReview.refresh", () => refresh()),

    vscode.commands.registerCommand(
      "deltaReview.addNote",
      (reply: vscode.CommentReply) => commentController.addNote(reply),
    ),

    vscode.commands.registerCommand(
      "deltaReview.editNoteTurn",
      (comment: vscode.Comment) => commentController.editNoteTurn(comment),
    ),

    vscode.commands.registerCommand(
      "deltaReview.saveNoteTurn",
      (comment: vscode.Comment) => commentController.saveNoteTurn(comment),
    ),

    vscode.commands.registerCommand(
      "deltaReview.cancelNoteTurn",
      (comment: vscode.Comment) => commentController.cancelNoteTurn(comment),
    ),

    vscode.commands.registerCommand(
      "deltaReview.deleteNoteTurn",
      (comment: vscode.Comment) => commentController.deleteNoteTurn(comment),
    ),

    vscode.commands.registerCommand(
      "deltaReview.deleteNoteThread",
      (thread: vscode.CommentThread) =>
        commentController.deleteNoteThread(thread),
    ),

    vscode.commands.registerCommand(
      "deltaReview.resolveNote",
      (target: vscode.CommentThread | vscode.CommentReply) =>
        commentController.resolveNote(target),
    ),

    vscode.commands.registerCommand(
      "deltaReview.unresolveNote",
      (target: vscode.CommentThread | vscode.CommentReply) =>
        commentController.unresolveNote(target),
    ),

    vscode.commands.registerCommand(
      "deltaReview.replyReopen",
      (reply: vscode.CommentReply) => commentController.replyReopen(reply),
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
        // Read out of `git`/`model`/`element` before enqueueing: a refresh or
        // repo switch can reassign them before the queued task runs
        const activeGit = git;
        const branch = model.branch;
        const paths = [element.file.path];
        await applyReviewStateChange("mark reviewed", () =>
          markReviewed(activeGit, branch, paths),
        );
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
        const activeGit = git;
        const branch = model.branch;
        const paths = [element.file.path];
        await applyReviewStateChange("unmark reviewed", () =>
          unmarkReviewed(activeGit, branch, paths),
        );
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
        const activeGit = git;
        const branch = model.branch;
        await applyReviewStateChange("unmark all files", () =>
          unmarkReviewed(activeGit, branch, paths),
        );
      },
    ),
    vscode.commands.registerCommand("deltaReview.openDiff", openDiff),

    // REVIEW NOTES row click: open the noted file's review diff with the
    // cursor at the note's current line and the thread expanded; a file with
    // no usable diff falls back to the note's own target document
    vscode.commands.registerCommand(
      "deltaReview.openNoteInDiff",
      async (thread: NoteThread) => {
        if (git === undefined) {
          return;
        }
        const line = Math.max(thread.note.currentStartLine - 1, 0);
        const selection = new vscode.Range(line, 0, line, 0);
        const file = model?.files.find(
          (candidate) => candidate.path === thread.note.file,
        );
        if (file !== undefined && !reviewDiffIsEmpty(file)) {
          // vscode.diff applies the selection to the modified (right) side,
          // so for a base-side note the cursor line is an approximation —
          // the expanded thread on the left is the visible cue
          await openDiff(file, selection);
          // Reveal approximation (no stable thread.reveal() in 1.90):
          // expand the note's thread once the diff editor exists — one tick
          // after the await, never a busy-wait
          await new Promise((resolve) => setTimeout(resolve, 0));
          commentController.expandThread(thread.note.id);
          await revealFileRow(file);
          return;
        }
        // Either the file left the review set, or its diff is empty on both
        // sides and so can hold no thread. Resolve the note's document
        // through the same module the thread attaches through, so the click
        // always lands where the thread renders. The content provider serves
        // "" for an unreadable blob exactly as it does for a legitimately
        // empty one, so a failed read is not detectable — the REVIEW NOTES
        // row actions are what guarantee the note stays closable.
        const absolutePath = join(git.repoRoot, thread.note.file);
        let onDisk = true;
        try {
          await access(absolutePath);
        } catch {
          onDisk = false;
        }
        const target = noteTargetFor(model, thread.note, onDisk);
        const { startLine } = noteAnchorLines(thread.note, target.lines);
        const targetLine = Math.max(startLine - 1, 0);
        await vscode.window.showTextDocument(
          target.kind === "working"
            ? vscode.Uri.file(join(git.repoRoot, target.path))
            : createReviewBaseUri(target.path, target.sha),
          { selection: new vscode.Range(targetLine, 0, targetLine, 0) },
        );
        // Working-side threads attach to the plain file URI and base-side
        // ones to the base document, so whichever opened, the thread renders
        // here
        commentController.expandThread(thread.note.id);
        // An empty-diff file is still in the review set, so it still syncs
        if (file !== undefined) {
          await revealFileRow(file);
        }
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.resolveNoteRow",
      (element?: NotesTreeElement) => setNoteRowResolved(element, true),
    ),

    vscode.commands.registerCommand(
      "deltaReview.unresolveNoteRow",
      (element?: NotesTreeElement) => setNoteRowResolved(element, false),
    ),

    // Unlike the thread's trash icon — which sits inside an expanded thread —
    // a tree row is an easy misclick, so this one confirms first
    vscode.commands.registerCommand(
      "deltaReview.deleteNoteRow",
      async (element?: NotesTreeElement) => {
        if (
          git === undefined ||
          model === undefined ||
          element?.kind !== "note"
        ) {
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          "Delete this review note and all its replies?",
          { modal: true },
          "Delete",
        );
        if (choice !== "Delete") {
          return;
        }
        // A background refresh or a repo switch can land while the modal is
        // open; TypeScript keeps the pre-await narrowing, so re-read both
        const activeGit = git;
        const activeModel = model;
        if (activeGit === undefined || activeModel === undefined) {
          return;
        }
        try {
          await deleteNote(
            activeGit,
            activeModel.branch,
            element.thread.note.id,
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Delta Review: failed to delete note (${error instanceof Error ? error.message : String(error)})`,
          );
          return;
        }
        await refresh();
      },
    ),

    // Clear Resolved: batch-deletes every resolved note on the current
    // branch. No confirmation modal — resolved notes were already confirmed
    // twice (agent addressed, reviewer resolved).
    vscode.commands.registerCommand(
      "deltaReview.clearResolvedNotes",
      async () => {
        if (git === undefined || model === undefined) {
          return;
        }
        const resolvedIds = currentNoteThreads
          .filter((thread) => thread.status === "resolved")
          .map((thread) => thread.note.id);
        if (resolvedIds.length === 0) {
          return;
        }
        try {
          await deleteNotes(git, model.branch, resolvedIds);
        } catch (error) {
          // E.g. an invalid on-disk notes file — the store refuses to
          // overwrite it; nothing changed, so nothing to refresh
          void vscode.window.showErrorMessage(
            `Delta Review: failed to clear resolved notes (${error instanceof Error ? error.message : String(error)})`,
          );
          return;
        }
        await refresh();
      },
    ),

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
        const activeGit = git;
        const branch = model.branch;
        await applyReviewStateChange("mark folder reviewed", () =>
          markReviewed(activeGit, branch, paths),
        );
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
        const activeGit = git;
        const branch = model.branch;
        await applyReviewStateChange("unmark folder", () =>
          unmarkReviewed(activeGit, branch, paths),
        );
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
        const activeGit = git;
        const branch = model.branch;
        await applyReviewStateChange("mark cluster reviewed", () =>
          markReviewed(activeGit, branch, paths),
        );
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
        const activeGit = git;
        const branch = model.branch;
        await applyReviewStateChange("unmark cluster", () =>
          unmarkReviewed(activeGit, branch, paths),
        );
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
        const activeGit = git;
        const branch = model.branch;
        await applyReviewStateChange("mark auto files reviewed", () =>
          markReviewed(activeGit, branch, paths),
        );
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
        const activeGit = git;
        const branch = model.branch;
        await applyReviewStateChange("unmark auto files", () =>
          unmarkReviewed(activeGit, branch, paths),
        );
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
      const activeGit = git;
      const branch = model.branch;
      await applyReviewStateChange("mark all files reviewed", () =>
        markReviewed(activeGit, branch, paths),
      );
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
        // Queued like every other review-state write: a clear that overtook a
        // pending write would be undone by it, the ref reappearing moments
        // after it was deleted
        const activeGit = git;
        const ref = reviewRefForBranch(model.branch);
        try {
          await reviewStateQueue.run(() =>
            activeGit.run(["update-ref", "-d", ref]),
          );
        } catch {
          // Ref did not exist — nothing to clear
        }
        await refresh();
      },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    // A thread's anchor can only be clamped into a document once that
    // document exists, and nothing else re-renders on open. Deliberately not
    // a refresh (git on every document open) and not renderThreads (it would
    // dispose the thread addNote adopts before its refresh lands) — the
    // controller's re-clamp touches ranges only.
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (
        document.uri.scheme === "file" ||
        document.uri.scheme === REVIEW_BASE_SCHEME
      ) {
        commentController.reclampThreadsFor(document);
      }
    }),
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
