import { access, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import * as vscode from "vscode";
import { baseBlobForNote } from "./baseDocument";
import {
  clusterChangesFiles,
  clusterChangesMarkPaths,
  clusterChangesRebuild,
  clusterChangesSignature,
  clusterChangesTitle,
  clusterLabelForKey,
  DiffDocument,
  fileForDiffDocument,
  isRowAlreadySelected,
  nothingToReviewMessage,
  refreshFailedMessage,
  sameClusterChangesSource,
} from "./clusterChanges";
import {
  ClusterModel,
  clusterFilesForKey,
  LineNote,
  loadClustersContract,
  resolveClusterModel,
  ReviewLevel,
} from "./clusters";
import { createNoteCommentController } from "./commentController";
import {
  createReviewBaseContentProvider,
  createReviewBaseUri,
  REVIEW_BASE_SCHEME,
} from "./contentProvider";
import { createReviewDecorationProvider } from "./decorations";
import {
  deltaReviewDirFor,
  documentNotePath,
  isDocumentNoteFileName,
  loadReviewDocuments,
  ReviewDocuments,
} from "./documents";
import { showBasePicker } from "./basePicker";
import {
  BaseResolution,
  clearBranchBase,
  createDetectionCache,
  resetDetectionCache,
  resolveDiffBase,
  writeBranchBase,
} from "./diffBase";
import {
  BaseStatusPresentation,
  baseStatusPresentation,
  mergeBaseErrorMessage,
  shouldPromptStale,
  staleKey,
  withStaleDismissed,
} from "./diffBaseUi";
import { createGit, Git } from "./git";
import { getGitApi, GitRepository } from "./gitExtensionApi";
import type { HashCacheEntry } from "./hashCache";
import {
  createRefreshScheduler,
  headFingerprint,
  isSelfWriteEventPath,
} from "./refreshScheduler";
import {
  computeReviewModel,
  FileReviewStatus,
  MergeBaseError,
  pathsWithReviewSnapshot,
  reviewSnapshotPaths,
  resolveBranch,
  ReviewFile,
  ReviewModel,
} from "./model";
import { buildDiffTitle, buildRowDescription } from "./moveDisplay";
import type { NoteDocument, ResponsesFile } from "./notes";
import { documentNoteGroupLabel } from "./notesGrouping";
import {
  noteAnchorLines,
  NoteTarget,
  noteTargetFor,
  reviewDiffIsEmpty,
} from "./noteTarget";
import { mergeThreads, NoteThread } from "./noteThreads";
import {
  isPendingUnread,
  marksFor,
  prunedRepoMarks,
  readMarkBranch,
  RepoReadMarks,
  withRepoReadMark,
} from "./pendingRead";
import {
  notesCollapseKeyFor,
  NotesTreeElement,
  NotesTreeProvider,
} from "./notesTreeProvider";
import {
  archiveWarning,
  buildAnchorResolver,
  deleteNote,
  deleteNotes,
  loadNotes,
  loadResponses,
  refreshDerived,
  setResolved,
} from "./notesStore";
import { agentLineNoteEntriesFor, provenanceEntriesFor } from "./provenance";
import {
  clearAllReviewSnapshots,
  deletePreDeletionRef,
  markReviewed,
  reviewRefForBranch,
  unmarkReviewed,
} from "./reviewState";
import { createSerialQueue } from "./serialQueue";
import {
  anchorSlices,
  anchorSlicesIntoCache,
  deleteSliceRef,
} from "./sliceAnchor";
import { documentPathFor, fileElementFor } from "./treeParents";
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
  let reviewDocuments: ReviewDocuments | undefined;

  // Group/folder collapse state, kept across refreshes and window reloads
  const collapsedKey = "deltaReview.collapsedGroups";
  const collapsed = new Set(
    context.workspaceState.get<string[]>(collapsedKey, []),
  );
  const persistCollapsed = (): void => {
    void context.workspaceState.update(collapsedKey, [...collapsed]);
  };

  // Pending-note read marks, workspace-local and never written to the notes
  // or responses files. notesKey is the repo and branch of the rendered
  // thread set; undefined whenever no successful notes load is rendered.
  const pendingReadMarksKey = "deltaReview.pendingReadMarks";
  let marks = context.workspaceState.get<RepoReadMarks>(
    pendingReadMarksKey,
    {},
  );
  let notesKey: { repo: string; branch: string } | undefined;
  const isUnread = (thread: NoteThread): boolean =>
    isPendingUnread(
      thread,
      notesKey === undefined
        ? {}
        : marksFor(marks, notesKey.repo, notesKey.branch),
    );

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
  // Drive the empty-tree welcome links that lead to a base that works
  const setBaseProblem = (
    problem: "missing" | "mergeBaseFailed" | undefined,
  ): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "deltaReview.baseMissing",
      problem === "missing",
    );
    void vscode.commands.executeCommand(
      "setContext",
      "deltaReview.mergeBaseFailed",
      problem === "mergeBaseFailed",
    );
  };
  setBaseProblem(undefined);

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
    () => reviewDocuments,
  );
  const treeView = vscode.window.createTreeView("deltaReview", {
    treeDataProvider: treeProvider,
  });

  // REVIEW NOTES: sibling SCM section below the review set. File groups
  // default to expanded, so they use the bare-key-while-collapsed convention
  // of the shared collapsed set (keys namespaced `notes:<path>`).
  const notesTreeProvider = new NotesTreeProvider(
    (key) => collapsed.has(key),
    isUnread,
    (document, file) =>
      documentNoteGroupLabel(
        document,
        file,
        clusterModel?.clusters.map((cluster) => cluster.label) ?? [],
      ),
  );
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
      if (
        element.kind === "file" ||
        element.kind === "message" ||
        element.kind === "document"
      ) {
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
      if (
        element.kind === "file" ||
        element.kind === "message" ||
        element.kind === "document"
      ) {
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
  const baseStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    49,
  );
  baseStatusItem.command = "deltaReview.setBranchBase";
  // StatusBarItem exposes no visibility, and the test hook reports it
  let baseStatusVisible = false;
  const renderBaseStatus = (presentation: BaseStatusPresentation): void => {
    baseStatusItem.text = presentation.text;
    baseStatusItem.tooltip = presentation.tooltip;
    baseStatusItem.backgroundColor =
      presentation.tint === "error"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : presentation.tint === "warning"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    baseStatusItem.show();
    baseStatusVisible = true;
  };
  const hideBaseStatus = (): void => {
    baseStatusItem.hide();
    baseStatusVisible = false;
  };
  let baseResolution: BaseResolution | undefined;
  const baseDetectionCache = createDetectionCache();
  const staleDismissedKey = "deltaReview.staleBaseDismissed";
  let staleDismissed = context.workspaceState.get<Record<string, string>>(
    staleDismissedKey,
    {},
  );
  const stalePrompting = new Set<string>();
  const staleKeyFor = async (activeGit: Git, branch: string): Promise<string> =>
    staleKey(dirname(await deltaReviewDirFor(activeGit)), branch);
  const dismissStale = (key: string, base: string): void => {
    staleDismissed = withStaleDismissed(staleDismissed, key, base);
    void context.workspaceState.update(staleDismissedKey, staleDismissed);
  };

  context.subscriptions.push(
    treeView,
    notesTreeView,
    statusBarItem,
    baseStatusItem,
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
    { isUnread, markRead: (thread) => markRead(thread) },
    () => reviewDocuments,
  );
  context.subscriptions.push(commentController);

  // The currently rendered thread set — what Clear Resolved operates on.
  // Only renderNoteThreads assigns it, so it always matches both surfaces.
  let currentNoteThreads: NoteThread[] = [];

  // Re-styles in place and never prunes: rendering here would dispose the
  // thread of a just-added note whose refresh has not landed yet
  const markRead = (thread: NoteThread): void => {
    if (notesKey === undefined) {
      return;
    }
    const next = withRepoReadMark(
      marks,
      notesKey.repo,
      notesKey.branch,
      thread,
    );
    if (next === marks) {
      return;
    }
    marks = next;
    void context.workspaceState.update(pendingReadMarksKey, marks);
    commentController.restyleThreads();
    notesTreeProvider.setThreads(currentNoteThreads);
  };

  // Renders the merged threads into both notes surfaces: the inline comment
  // threads and the REVIEW NOTES tree (with its to-handle badge). Every call
  // site is generation-guarded inside refresh(), so the two surfaces always
  // show the same thread set.
  const renderNoteThreads = (threads: NoteThread[]): void => {
    currentNoteThreads = threads;
    commentController.renderThreads(threads);
    notesTreeProvider.setThreads(threads);
    // Open, addressed and pending (read or unread) are not done; resolved notes are.
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
  let publishCount = 0;
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
  // Origin slices written for declared extractions, kept across refreshes so a
  // refresh re-slices only what the merge base actually moved. Keyed by origin
  // blob and declared lines, so it too is invalidated by content rather than by
  // branch — and cleared alongside the hash cache on a repo switch.
  const sliceCache = new Map<string, string>();
  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration;
    if (git === undefined) {
      model = undefined;
      clusterModel = undefined;
      reviewDocuments = undefined;
      setClustersAvailable(false);
      treeProvider.setModel(undefined);
      treeView.badge = undefined;
      treeView.message =
        "Open a folder inside a git repository to start reviewing.";
      statusBarItem.hide();
      baseResolution = undefined;
      setBaseProblem(undefined);
      hideBaseStatus();
      notesKey = undefined;
      renderNoteThreads([]);
      commentController.renderProvenanceThreads([]);
      commentController.renderAgentLineThreads([]);
      return;
    }
    const configuration = vscode.workspace.getConfiguration("deltaReview");
    const autoReviewGlobs =
      configuration.get<string[]>("autoReview.globs") ?? [];
    // This refresh's own resolution, so the fatal catch never reads one a
    // newer refresh left behind
    let resolution: BaseResolution | undefined;
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
      resolution = await resolveDiffBase(
        git,
        branch,
        configuration.get<string>("baseBranch") ?? "main",
        baseDetectionCache,
      );
      const resolutionStaleKey = resolution.stale
        ? await staleKeyFor(git, resolution.branch)
        : undefined;
      if (generation !== refreshGeneration) {
        return;
      }
      baseResolution = resolution;
      if (resolution.missing) {
        model = undefined;
        clusterModel = undefined;
        setClustersAvailable(false);
        treeProvider.setModel(undefined);
        treeView.badge = undefined;
        treeView.message = `⚠ Base ${resolution.base} for branch ${resolution.branch} does not resolve.`;
        statusBarItem.hide();
        setBaseProblem("missing");
        renderBaseStatus(baseStatusPresentation(resolution, undefined));
        notesKey = undefined;
        renderNoteThreads([]);
        commentController.renderProvenanceThreads([]);
        commentController.renderAgentLineThreads([]);
        return;
      }
      const baseBranch = resolution.base;
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
      const notes =
        contractResult.state === "ok"
          ? contractResult.contract.notes
          : new Map<string, string>();
      const lineNotes =
        contractResult.state === "ok"
          ? contractResult.contract.lineNotes
          : new Map<string, LineNote[]>();
      const levels =
        contractResult.state === "ok"
          ? contractResult.contract.levels
          : new Map<string, ReviewLevel>();
      // Slices this refresh writes go into its own copy and reach the shared
      // cache only once anchored, so a refresh superseded midway leaves no
      // unanchored sha behind for a later one to reuse
      const refreshSliceCache = new Map(sliceCache);
      let computed = await computeReviewModel(git, baseBranch, {
        autoReviewGlobs,
        branch,
        moves,
        notes,
        lineNotes,
        levels,
        hashCache,
        sliceCache: refreshSliceCache,
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
            notes,
            lineNotes,
            levels,
            hashCache,
            sliceCache: refreshSliceCache,
          });
          if (generation !== refreshGeneration) {
            return;
          }
        }
      }
      // The slices this model diffs against exist only as loose objects until
      // something points at them, so they are anchored before the model that
      // names them is published — after the auto-mark recomputation, whose
      // slice set is the one that counts. Every refresh still current at its
      // queue slot anchors: an unchanged set costs a temp index and no commit,
      // and a ref deleted outside the extension comes back here.
      const gitForAnchor = git;
      const anchorBranch = computed.branch;
      const anchorShas = computed.sliceShas;
      try {
        await reviewStateQueue.run(() =>
          anchorSlicesIntoCache({
            anchor: (shas) => anchorSlices(gitForAnchor, anchorBranch, shas),
            isCurrent: () => generation === refreshGeneration,
            shas: anchorShas,
            candidates: refreshSliceCache,
            cache: sliceCache,
          }),
        );
      } catch (error) {
        console.warn("Delta Review: could not anchor origin slices", error);
      }
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

      // Labels only from a valid contract; the branch document needs none
      const documents = await loadReviewDocuments(
        await deltaReviewDirFor(git),
        branch,
        contractResult.state === "ok"
          ? contractResult.contract.clusters.map((cluster) => cluster.label)
          : [],
      );
      if (generation !== refreshGeneration) {
        return;
      }
      reviewDocuments = documents;

      model = computed;
      treeProvider.setModel(model);
      publishCount += 1;
      // Rebuilt from the model beside the tree, not inside renderNoteThreads:
      // provenance comes from the clusters contract, so it must survive a
      // notes file that fails to load below.
      commentController.renderProvenanceThreads(provenanceEntriesFor(model));
      commentController.renderAgentLineThreads(agentLineNoteEntriesFor(model));
      treeView.message = contractWarning;
      void syncActiveClusterChanges();

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
      setBaseProblem(undefined);
      const promptStale =
        resolutionStaleKey !== undefined &&
        shouldPromptStale(
          resolution,
          staleDismissed,
          resolutionStaleKey,
          stalePrompting,
        );
      if (promptStale) {
        stalePrompting.add(resolutionStaleKey);
      }
      renderBaseStatus(
        baseStatusPresentation(resolution, model.mergeBase, {
          promptOpen:
            resolutionStaleKey !== undefined &&
            stalePrompting.has(resolutionStaleKey),
        }),
      );
      if (promptStale) {
        void promptStaleBase(git, resolution, resolutionStaleKey);
      }

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
        const readDocumentContent = async (
          document: NoteDocument,
          fileName: string,
        ): Promise<string | undefined> => {
          if (
            reviewDocuments === undefined ||
            !isDocumentNoteFileName(document, fileName)
          ) {
            return undefined;
          }
          try {
            return await readFile(
              documentNotePath(reviewDocuments, document, fileName),
              "utf8",
            );
          } catch {
            return undefined;
          }
        };
        // Prunes the loaded repo's marks on a successful notes load; false
        // when a newer refresh superseded this one
        const pruneReadMarks = async (
          threads: readonly NoteThread[],
        ): Promise<boolean> => {
          let liveBranches: Set<string> | undefined;
          if (
            Object.keys(marks[gitForNotes.repoRoot] ?? {}).some(
              (key) => key !== computed.branch,
            )
          ) {
            try {
              const output = await gitForNotes.run([
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads",
              ]);
              liveBranches = new Set(
                output
                  .split("\n")
                  .filter((line) => line.startsWith("refs/heads/"))
                  .map((line) => line.slice("refs/heads/".length)),
              );
            } catch {
              liveBranches = undefined;
            }
            if (generation !== refreshGeneration) {
              return false;
            }
          }
          const pruned = prunedRepoMarks(
            marks,
            gitForNotes.repoRoot,
            readMarkBranch(computed.branch),
            threads,
            liveBranches,
          );
          if (pruned !== marks) {
            marks = pruned;
            void context.workspaceState.update(pendingReadMarksKey, marks);
          }
          return true;
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
          notesKey = undefined;
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
              readDocumentContent,
              baseBlobFor: (path, contentBlob) =>
                baseBlobForNote(computed, path, contentBlob),
              anchorResolves,
            },
          );
          if (generation !== refreshGeneration) {
            return;
          }
          const threads = mergeThreads(refreshed, responses, anchorResolves);
          if (!(await pruneReadMarks(threads))) {
            return;
          }
          notesKey = {
            repo: gitForNotes.repoRoot,
            branch: readMarkBranch(computed.branch),
          };
          renderNoteThreads(threads);
        } else {
          // Missing or empty — clear any rendered threads
          if (notesResult.state === "ok") {
            if (!(await pruneReadMarks([]))) {
              return;
            }
            notesKey = {
              repo: gitForNotes.repoRoot,
              branch: readMarkBranch(computed.branch),
            };
          } else {
            notesKey = undefined;
          }
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
      statusBarItem.hide();
      // Fatal model errors win over any contract warning. A failed merge-base
      // keeps the base item up: it is the way to a base that works.
      if (error instanceof MergeBaseError && resolution !== undefined) {
        treeView.message = mergeBaseErrorMessage(resolution);
        setBaseProblem("mergeBaseFailed");
        renderBaseStatus(
          baseStatusPresentation(resolution, undefined, {
            mergeBaseFailed: true,
          }),
        );
      } else {
        treeView.message = `Delta Review: ${error instanceof Error ? error.message : String(error)}`;
        setBaseProblem(undefined);
        hideBaseStatus();
      }
      notesKey = undefined;
      renderNoteThreads([]);
      commentController.renderProvenanceThreads([]);
      commentController.renderAgentLineThreads([]);
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

  const markClusterPaths = async (
    activeGit: Git,
    branch: string,
    paths: string[],
  ): Promise<void> =>
    applyReviewStateChange("mark cluster reviewed", () =>
      markReviewed(activeGit, branch, paths),
    );

  const refreshScheduler = createRefreshScheduler({
    delayMs: 400,
    maxWaitMs: 1500,
    run: refresh,
  });
  const scheduleRefresh = (): void => refreshScheduler.schedule();
  context.subscriptions.push(
    new vscode.Disposable(() => refreshScheduler.cancel()),
  );

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
    const onRepoEvent = (uri: vscode.Uri): void => {
      if (!isSelfWriteEventPath(uri.fsPath)) {
        scheduleRefresh();
      }
    };
    repoWatcherDisposables = [
      watcher,
      watcher.onDidChange(onRepoEvent),
      watcher.onDidCreate(onRepoEvent),
      watcher.onDidDelete(onRepoEvent),
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
      new vscode.RelativePattern(
        vscode.Uri.file(contractDir),
        "{*.json,*.md,cluster-notes-*/*.md}",
      ),
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
    // Cached hashes are keyed by repo-relative path, and cached slices name
    // objects in this checkout's database, so neither means anything in another
    hashCache.clear();
    sliceCache.clear();
    resetDetectionCache(baseDetectionCache);
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

  const diffUris = (
    activeGit: Git,
    file: ReviewFile,
  ): { left: vscode.Uri; right: vscode.Uri } => ({
    // The path identifying the base document the model actually resolved: a
    // repo origin's old path when the base really is that origin's blob, the
    // file's own path otherwise. Always repo-relative, so a declared external
    // origin can never escape the repo through a base-document URI.
    left: createReviewBaseUri(file.diffBasePath, file.diffBaseSha),
    right: file.deleted
      ? createReviewBaseUri(file.path, undefined)
      : vscode.Uri.file(join(activeGit.repoRoot, file.path)),
  });

  type ClusterChangesEntry = {
    clusterKey: string;
    label: string;
    paths: string[];
    leftSides: { path: string; basePath: string; baseQuery: string }[];
    repoRoot: string;
    branch: string;
    signature: string[];
  };

  // Title of the one open combined cluster diff -> what it shows
  const clusterChangesTabs = new Map<string, ClusterChangesEntry>();
  // Set while a rebuild swaps a title's tab, so the old tab closing does not
  // drop the entry before the new tab exists
  let rebuildingTitle: string | undefined;
  // Title -> signature whose rebuild saw no tab open, so refreshes do not
  // retry it until the cluster's diff bases change again
  const failedRebuildSignature = new Map<string, string>();

  // The multi-diff editor appends a localized file count, `<title> (2 files)`,
  // once its resources resolve
  const isClusterChangesLabel = (label: string, title: string): boolean =>
    label === title ||
    (label.startsWith(title) &&
      /^ \(\d+[^()]*\)$/.test(label.slice(title.length)));

  // The stable API has no multi-diff tab input class, so a combined diff is a
  // tab whose input matches none of the known ones
  const isStableTabInput = (input: unknown): boolean =>
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputTextDiff ||
    input instanceof vscode.TabInputCustom ||
    input instanceof vscode.TabInputWebview ||
    input instanceof vscode.TabInputNotebook ||
    input instanceof vscode.TabInputNotebookDiff ||
    input instanceof vscode.TabInputTerminal;

  const clusterChangesTabsFor = (title: string): vscode.Tab[] =>
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          isClusterChangesLabel(tab.label, title) &&
          !isStableTabInput(tab.input),
      );

  // More than one title matches only when a cluster label itself ends in a
  // file-count-like suffix
  const clusterChangesTitlesForTab = (tab: vscode.Tab | undefined): string[] =>
    tab === undefined || isStableTabInput(tab.input)
      ? []
      : [...clusterChangesTabs.keys()].filter((title) =>
          isClusterChangesLabel(tab.label, title),
        );

  const isClusterChangesTab = (tab: vscode.Tab | undefined): boolean =>
    clusterChangesTitlesForTab(tab).length > 0;

  const activeClusterChanges = ():
    { title: string; entry: ClusterChangesEntry } | undefined => {
    const titles = clusterChangesTitlesForTab(
      vscode.window.tabGroups.activeTabGroup.activeTab,
    );
    return titles.length === 1
      ? { title: titles[0], entry: clusterChangesTabs.get(titles[0])! }
      : undefined;
  };

  const updateClusterChangesContext = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "deltaReview.clusterChangesActive",
      isClusterChangesTab(vscode.window.tabGroups.activeTabGroup.activeTab),
    );
  };

  const buildClusterChanges = (
    activeGit: Git,
    branch: string,
    clusterKey: string,
    label: string,
    files: readonly ReviewFile[],
  ): {
    entry: ClusterChangesEntry;
    resources: [vscode.Uri, vscode.Uri, vscode.Uri][];
  } => {
    const sides = files.map((file) => ({ file, ...diffUris(activeGit, file) }));
    return {
      entry: {
        clusterKey,
        label,
        paths: files.map((file) => file.path),
        leftSides: sides.map((side) => ({
          path: side.file.path,
          basePath: side.left.path.replace(/^\//, ""),
          baseQuery: side.left.query,
        })),
        repoRoot: activeGit.repoRoot,
        branch,
        signature: clusterChangesSignature(files),
      },
      resources: sides.map((side) => [
        vscode.Uri.file(join(activeGit.repoRoot, side.file.path)),
        side.left,
        side.right,
      ]),
    };
  };

  // Resolves before the editor opens: the `vscode.changes` handler does not
  // return the command it forwards to
  const showClusterChanges = async (
    title: string,
    resources: [vscode.Uri, vscode.Uri, vscode.Uri][],
  ): Promise<void> => {
    await vscode.commands.executeCommand("vscode.changes", title, resources);
  };

  // Records `next` in the same callback that first exposes the new tab, so
  // the title-bar mark command never pairs a tab with an entry it does not show
  const waitForNewClusterChangesTab = (
    title: string,
    before: Set<vscode.Tab>,
    next: ClusterChangesEntry,
    timeoutMs = 3000,
  ): Promise<vscode.Tab | undefined> =>
    new Promise((resolve) => {
      const finish = (tab: vscode.Tab | undefined): void => {
        clearTimeout(timer);
        listener.dispose();
        resolve(tab);
      };
      const listener = vscode.window.tabGroups.onDidChangeTabs((event) => {
        const tab = [...event.opened, ...event.changed].find(
          (candidate) =>
            isClusterChangesLabel(candidate.label, title) &&
            !isStableTabInput(candidate.input) &&
            !before.has(candidate),
        );
        if (tab !== undefined) {
          clusterChangesTabs.set(title, next);
          finish(tab);
        }
      });
      const timer = setTimeout(() => finish(undefined), timeoutMs);
    });

  // Title -> listener adopting a rebuild's tab that opens after its wait
  // timed out, so the entry and memo match what the late tab shows
  const lateClusterChangesTabs = new Map<string, vscode.Disposable>();
  const cancelLateClusterChangesTab = (title: string): void => {
    lateClusterChangesTabs.get(title)?.dispose();
    lateClusterChangesTabs.delete(title);
  };
  context.subscriptions.push({
    dispose: () => {
      for (const title of [...lateClusterChangesTabs.keys()]) {
        cancelLateClusterChangesTab(title);
      }
    },
  });

  // An old tab still open beside the late one leaves the entry alone: the
  // mark command refuses duplicates, and the next sync rebuilds once the
  // memo is cleared and a single tab remains
  const watchLateClusterChangesTab = (
    title: string,
    before: Set<vscode.Tab>,
    next: ClusterChangesEntry,
  ): void => {
    cancelLateClusterChangesTab(title);
    const listener = vscode.window.tabGroups.onDidChangeTabs((event) => {
      const late = [...event.opened, ...event.changed].some(
        (candidate) =>
          isClusterChangesLabel(candidate.label, title) &&
          !isStableTabInput(candidate.input) &&
          !before.has(candidate),
      );
      if (!late) {
        return;
      }
      cancelLateClusterChangesTab(title);
      failedRebuildSignature.delete(title);
      if (clusterChangesTabsFor(title).every((tab) => !before.has(tab))) {
        clusterChangesTabs.set(title, next);
      }
      updateClusterChangesContext();
    });
    lateClusterChangesTabs.set(title, listener);
  };

  const clusterChangesQueue = createSerialQueue();

  const rebuildClusterChanges = async (
    activeGit: Git,
    branch: string,
    title: string,
    entry: ClusterChangesEntry,
    files: ReviewFile[],
  ): Promise<void> => {
    const before = new Set(clusterChangesTabsFor(title));
    const wasPreview =
      vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview === true;
    const { entry: next, resources } = buildClusterChanges(
      activeGit,
      branch,
      entry.clusterKey,
      entry.label,
      files,
    );
    cancelLateClusterChangesTab(title);
    try {
      rebuildingTitle = title;
      const waiting = waitForNewClusterChangesTab(title, before, next);
      await showClusterChanges(title, resources);
      const opened = await waiting;
      if (opened !== undefined) {
        failedRebuildSignature.delete(title);
        const stillOpen = clusterChangesTabsFor(title).filter((tab) =>
          before.has(tab),
        );
        if (stillOpen.length > 0) {
          await vscode.window.tabGroups.close(stillOpen);
        }
        if (!wasPreview) {
          await vscode.commands.executeCommand("workbench.action.keepEditor");
        }
      } else {
        failedRebuildSignature.set(
          title,
          clusterChangesSignature(files).join("\n"),
        );
        watchLateClusterChangesTab(title, before, next);
        void vscode.window.showInformationMessage(
          refreshFailedMessage(entry.label),
        );
      }
    } finally {
      rebuildingTitle = undefined;
      if (clusterChangesTabsFor(title).length === 0) {
        clusterChangesTabs.delete(title);
        failedRebuildSignature.delete(title);
      }
      updateClusterChangesContext();
      // Catches a tab switch whose sync was skipped mid-rebuild; it queues
      // behind this task, so it must not be awaited here
      void syncActiveClusterChanges();
    }
  };

  // Rebuilds only the active tab of the active group: a background rebuild
  // would steal focus and move tabs, so those wait until they are activated
  const syncActiveClusterChanges = (): Promise<void> =>
    clusterChangesQueue.run(async () => {
      try {
        if (
          git === undefined ||
          model === undefined ||
          clusterModel === undefined
        ) {
          return;
        }
        const active = activeClusterChanges();
        if (
          active === undefined ||
          clusterChangesTabsFor(active.title).length !== 1
        ) {
          return;
        }
        const { title, entry } = active;
        const result = clusterChangesRebuild(
          {
            title,
            label: entry.label,
            repoRoot: entry.repoRoot,
            branch: entry.branch,
            signature: entry.signature,
          },
          {
            title: clusterChangesTitle(clusterModel, entry.clusterKey),
            label: clusterLabelForKey(clusterModel, entry.clusterKey),
            repoRoot: git.repoRoot,
            branch: model.branch,
          },
          clusterFilesForKey(clusterModel, entry.clusterKey),
        );
        if (
          result.kind !== "rebuild" ||
          clusterChangesSignature(result.files).join("\n") ===
            failedRebuildSignature.get(title)
        ) {
          return;
        }
        await rebuildClusterChanges(
          git,
          model.branch,
          title,
          entry,
          result.files,
        );
      } catch (error) {
        console.warn("Delta Review: could not refresh cluster changes", error);
      }
    });

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of event.closed) {
        const titles = [...clusterChangesTabs.keys()].filter(
          (title) =>
            title !== rebuildingTitle &&
            isClusterChangesLabel(tab.label, title),
        );
        for (const title of titles) {
          if (clusterChangesTabsFor(title).length === 0) {
            clusterChangesTabs.delete(title);
            failedRebuildSignature.delete(title);
          }
        }
      }
      updateClusterChangesContext();
      if (rebuildingTitle === undefined) {
        void syncActiveClusterChanges();
      }
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => {
      updateClusterChangesContext();
      if (rebuildingTitle === undefined) {
        void syncActiveClusterChanges();
      }
    }),
  );

  const openDiff = async (
    file: ReviewFile,
    selection?: vscode.Range,
  ): Promise<void> => {
    if (git === undefined) {
      return;
    }
    const { left: leftUri, right: rightUri } = diffUris(git, file);
    const baseLabel = file.diffBaseIsReviewedSnapshot
      ? "last reviewed"
      : "merge base";
    const workingLabel = file.deleted ? "deleted" : "working tree";
    // Assembled by the display module, which owns the move wording the
    // tooltip uses too
    const title = buildDiffTitle({
      path: file.path,
      movedFrom: file.movedFrom,
      originLines: file.originLines,
      baseLabel,
      workingLabel,
    });
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

  const noteTargetUri = (activeGit: Git, target: NoteTarget): vscode.Uri => {
    switch (target.kind) {
      case "working":
        return vscode.Uri.file(join(activeGit.repoRoot, target.path));
      case "base":
        return createReviewBaseUri(target.path, target.sha);
      case "document":
        return vscode.Uri.file(
          reviewDocuments === undefined
            ? target.file
            : documentNotePath(reviewDocuments, target.document, target.file),
        );
    }
  };

  // A document note never goes through model.files (a repo file can share
  // its name) and has no diff or DELTA REVIEW row to sync
  const openDocumentNote = async (thread: NoteThread): Promise<void> => {
    if (git === undefined) {
      return;
    }
    const document = thread.note.document;
    let exists = false;
    if (reviewDocuments !== undefined && document !== undefined) {
      try {
        await access(
          documentNotePath(reviewDocuments, document, thread.note.file),
        );
        exists = true;
      } catch {
        exists = false;
      }
    }
    const target = noteTargetFor(model, thread.note, exists);
    const { startLine } = noteAnchorLines(thread.note, target.lines);
    const targetLine = Math.max(startLine - 1, 0);
    await vscode.window.showTextDocument(noteTargetUri(git, target), {
      selection: new vscode.Range(targetLine, 0, targetLine, 0),
    });
    commentController.expandThread(thread.note.id);
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

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (
        editor === undefined ||
        git === undefined ||
        model === undefined ||
        !treeView.visible
      ) {
        return;
      }
      const active = activeClusterChanges();
      if (active === undefined) {
        return;
      }
      const { entry } = active;
      if (
        !sameClusterChangesSource(entry, {
          repoRoot: git.repoRoot,
          branch: model.branch,
        })
      ) {
        return;
      }
      const uri = editor.document.uri;
      let doc: DiffDocument;
      if (uri.scheme === "file") {
        const path = relative(git.repoRoot, uri.fsPath).replace(/\\/g, "/");
        if (path.startsWith("..")) {
          return;
        }
        doc = { scheme: "file", path };
      } else if (uri.scheme === REVIEW_BASE_SCHEME) {
        doc = {
          scheme: "base",
          path: uri.path.replace(/^\//, ""),
          query: uri.query,
        };
      } else {
        return;
      }
      const files = model.files.filter((f) => entry.paths.includes(f.path));
      let file: ReviewFile | undefined;
      if (doc.scheme === "base") {
        const { path, query } = doc;
        const side = entry.leftSides.find(
          (s) => s.basePath === path && s.baseQuery === query,
        );
        if (side !== undefined) {
          file = files.find((f) => f.path === side.path);
        }
      }
      file ??= fileForDiffDocument(files, doc);
      if (file === undefined) {
        return;
      }
      const selected = treeView.selection.flatMap((e) =>
        e.kind === "file" ? [e.file.path] : [],
      );
      if (isRowAlreadySelected(selected, file.path)) {
        return;
      }
      void revealFileRow(file);
    }),
  );

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

  // Row clicks pass the file Uri; inline actions pass the tree element
  const documentUriFor = (
    target: vscode.Uri | ReviewTreeElement | undefined,
  ): vscode.Uri | undefined => {
    if (target instanceof vscode.Uri) {
      return target;
    }
    if (target?.kind !== "document") {
      return undefined;
    }
    const path = documentPathFor(reviewDocuments, target);
    return path === undefined ? undefined : vscode.Uri.file(path);
  };

  // `folderScopeFiles` narrowed to the rows the folder actually renders: the
  // Reviewed bucket shows reviewed files, a cluster body shows only its
  // needs-review files, and a status-scoped folder shows that status. A bulk
  // action must never reach a file rendered under the other group.
  const renderedFolderFiles = (element: {
    status?: FileReviewStatus;
    clusterKey?: string;
    inReviewedBucket?: true;
  }): ReviewFile[] => {
    const scope = folderScopeFiles(element);
    if (element.inReviewedBucket === true) {
      return scope.filter((file) => file.status === FileReviewStatus.Reviewed);
    }
    if (element.clusterKey !== undefined) {
      return scope.filter(
        (file) => file.status === FileReviewStatus.NeedsReview,
      );
    }
    return scope.filter((file) => file.status === element.status);
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

  // Acts on the repo, branch and bases captured when the prompt opened, even
  // if the active repo has changed since
  const promptStaleBase = async (
    activeGit: Git,
    resolution: BaseResolution,
    key: string,
  ): Promise<void> => {
    const { branch, base, fallback } = resolution;
    const switchLabel = `Switch to ${fallback}`;
    const keepLabel = `Keep ${base}`;
    try {
      const choice = await vscode.window.showWarningMessage(
        `Base ${base} is fully merged into ${fallback}. Switch the diff base for ${branch} to ${fallback}?`,
        switchLabel,
        keepLabel,
        "Choose…",
      );
      if (choice === switchLabel) {
        await writeBranchBase(activeGit, branch, fallback);
      } else if (choice === keepLabel) {
        await writeBranchBase(activeGit, branch, base);
        dismissStale(key, base);
      } else if (choice === "Choose…") {
        const picked = await showBasePicker({
          git: activeGit,
          resolution,
          preferFirst: fallback,
        });
        if (picked.outcome === "cancelled") {
          dismissStale(key, base);
        } else if (picked.outcome === "picked") {
          dismissStale(key, picked.ref);
        }
      } else {
        dismissStale(key, base);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Delta Review: failed to set the diff base (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      stalePrompting.delete(key);
    }
    await refresh();
  };

  const setBranchBase = async (): Promise<void> => {
    const activeGit = git;
    const resolution = baseResolution;
    if (activeGit === undefined || resolution === undefined) {
      void vscode.window.showInformationMessage(
        "Delta Review: no repository is active.",
      );
      return;
    }
    if (resolution.branch === "HEAD") {
      void vscode.window.showInformationMessage(
        "Delta Review: detached HEAD has no branch to set a base for.",
      );
      return;
    }
    try {
      const key = await staleKeyFor(activeGit, resolution.branch);
      const picked = await showBasePicker({
        git: activeGit,
        resolution,
        preferFirst:
          resolution.stale && stalePrompting.has(key)
            ? resolution.fallback
            : undefined,
      });
      if (picked.outcome === "cancelled") {
        return;
      }
      if (picked.outcome === "picked") {
        dismissStale(key, picked.ref);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Delta Review: failed to set the diff base (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    await refresh();
  };

  const useAutomaticBase = async (): Promise<void> => {
    const activeGit = git;
    const resolution = baseResolution;
    if (activeGit === undefined || resolution === undefined) {
      void vscode.window.showInformationMessage(
        "Delta Review: no repository is active.",
      );
      return;
    }
    if (resolution.branch === "HEAD") {
      return;
    }
    try {
      await clearBranchBase(activeGit, resolution.branch);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Delta Review: failed to clear the diff base (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    await refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("deltaReview.refresh", () => refresh()),

    vscode.commands.registerCommand("deltaReview.setBranchBase", () =>
      setBranchBase(),
    ),

    vscode.commands.registerCommand("deltaReview.useAutomaticBase", () =>
      useAutomaticBase(),
    ),

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
      "deltaReview.markNoteRead",
      (thread: vscode.CommentThread) => commentController.markNoteRead(thread),
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
          element?.kind !== "file" ||
          // Without a snapshot there is nothing to drop, and the write would
          // be a no-op state commit
          !element.file.hasReviewSnapshot
        ) {
          return;
        }
        const activeGit = git;
        const branch = model.branch;
        const paths = reviewSnapshotPaths(element.file);
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
        const activeGit = git;
        const branch = model.branch;
        // Scoped to the branch, not to the review set: a snapshot for a path
        // that no longer shows up would survive a path list and keep acting
        // as that path's diff base if it came back
        await applyReviewStateChange("unmark all files", () =>
          clearAllReviewSnapshots(activeGit, branch),
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
        if (thread.note.document !== undefined) {
          await openDocumentNote(thread);
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
        await vscode.window.showTextDocument(noteTargetUri(git, target), {
          selection: new vscode.Range(targetLine, 0, targetLine, 0),
        });
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

    vscode.commands.registerCommand(
      "deltaReview.markNoteRowRead",
      (element?: NotesTreeElement) =>
        element?.kind === "note" && markRead(element.thread),
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
    // branch, archiving what it removes. No confirmation modal — resolved
    // notes were already confirmed twice (agent addressed, reviewer
    // resolved). Archive trouble only warns: the notes are gone either way,
    // so failing the command would misreport what happened.
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
        // Declared out here so the outcome survives the try block
        let result: Awaited<ReturnType<typeof deleteNotes>>;
        try {
          result = await deleteNotes(git, model.branch, resolvedIds);
        } catch (error) {
          // E.g. an invalid on-disk notes file — the store refuses to
          // overwrite it; nothing changed, so nothing to refresh
          void vscode.window.showErrorMessage(
            `Delta Review: failed to clear resolved notes (${error instanceof Error ? error.message : String(error)})`,
          );
          return;
        }
        const warning = archiveWarning(result.archive, result.deleted);
        if (warning !== undefined) {
          // Never awaited — that would hold the refresh until the toast is
          // dismissed
          void vscode.window.showWarningMessage(warning);
        }
        await refresh();
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.openDocument",
      async (target?: vscode.Uri | ReviewTreeElement) => {
        const uri = documentUriFor(target);
        if (uri === undefined) {
          return;
        }
        await vscode.window.showTextDocument(uri);
      },
    ),

    vscode.commands.registerCommand(
      "deltaReview.previewDocument",
      async (target?: vscode.Uri | ReviewTreeElement) => {
        const uri = documentUriFor(target);
        if (uri === undefined) {
          return;
        }
        await vscode.commands.executeCommand("markdown.showPreview", uri);
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
        const paths = renderedFolderFiles(element)
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
        const paths = pathsWithReviewSnapshot(
          renderedFolderFiles(element).filter((file) =>
            file.path.startsWith(`${element.path}/`),
          ),
        );
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
      "deltaReview.openClusterChanges",
      (element?: ReviewTreeElement) =>
        clusterChangesQueue.run(async () => {
          if (
            git === undefined ||
            model === undefined ||
            clusterModel === undefined ||
            element?.kind !== "cluster"
          ) {
            return;
          }
          const activeGit = git;
          const branch = model.branch;
          const label = clusterLabelForKey(clusterModel, element.clusterKey);
          const files = clusterChangesFiles(
            clusterFilesForKey(clusterModel, element.clusterKey),
          );
          if (files.length === 0) {
            void vscode.window.showInformationMessage(
              nothingToReviewMessage(label),
            );
            return;
          }
          const title = clusterChangesTitle(clusterModel, element.clusterKey);
          cancelLateClusterChangesTab(title);
          const stale = clusterChangesTabsFor(title);
          if (
            stale.length > 0 &&
            !(await vscode.window.tabGroups.close(stale))
          ) {
            return;
          }
          const { entry, resources } = buildClusterChanges(
            activeGit,
            branch,
            element.clusterKey,
            label,
            files,
          );
          clusterChangesTabs.set(title, entry);
          await showClusterChanges(title, resources);
          updateClusterChangesContext();
        }),
    ),

    // editor/title passes (resource, { groupId }): the resource is the
    // multi-diff's random `multi-diff-editor:` source, which no stable tab
    // input exposes, and groupId is internal (TabGroup has only viewColumn).
    // Neither maps to a vscode.Tab, so the press is trusted only when no other
    // group's title bar could have shown the button.
    vscode.commands.registerCommand(
      "deltaReview.markClusterChangesReviewed",
      async (..._args: unknown[]) => {
        const cantTell = (): void => {
          void vscode.window.showInformationMessage(
            "Can't tell which editor this button belongs to. Focus the cluster's combined diff and try again.",
          );
        };
        const activeGroup = vscode.window.tabGroups.activeTabGroup;
        const titles = clusterChangesTitlesForTab(activeGroup.activeTab);
        if (titles.length > 1) {
          cantTell();
          return;
        }
        const active = activeClusterChanges();
        if (
          active === undefined ||
          git === undefined ||
          model === undefined ||
          clusterModel === undefined
        ) {
          return;
        }
        const { title, entry } = active;
        const activeGit = git;
        const branch = model.branch;
        if (clusterChangesTabsFor(title).length > 1) {
          void vscode.window.showInformationMessage(
            `More than one '${title}' tab is open. Close them and reopen it from the Delta Review pane.`,
          );
          return;
        }
        if (
          vscode.window.tabGroups.all.some(
            (group) =>
              group !== activeGroup &&
              group.activeTab !== undefined &&
              !isStableTabInput(group.activeTab.input),
          )
        ) {
          cantTell();
          return;
        }
        const result = clusterChangesMarkPaths(
          {
            title,
            label: entry.label,
            paths: entry.paths,
            repoRoot: entry.repoRoot,
            branch: entry.branch,
          },
          {
            title: clusterChangesTitle(clusterModel, entry.clusterKey),
            label: clusterLabelForKey(clusterModel, entry.clusterKey),
            repoRoot: activeGit.repoRoot,
            branch,
          },
          clusterFilesForKey(clusterModel, entry.clusterKey),
        );
        if ("message" in result) {
          void vscode.window.showInformationMessage(result.message);
          return;
        }
        await markClusterPaths(activeGit, branch, result.paths);
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
        await markClusterPaths(git, model.branch, paths);
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
        // Full membership, matching the counts the cluster header shows
        const paths = pathsWithReviewSnapshot(
          clusterFilesForKey(clusterModel, element.clusterKey),
        );
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
        // One Auto subgroup exists per status group, so the press must stay
        // inside the pressed group's rows
        const paths = pathsWithReviewSnapshot(
          model.files.filter(
            (file) => file.triage === "auto" && file.status === element.status,
          ),
        );
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
        const clearedBranch = model.branch;
        const ref = reviewRefForBranch(clearedBranch);
        await reviewStateQueue.run(async () => {
          try {
            await activeGit.run(["update-ref", "-d", ref]);
          } catch {
            // Ref did not exist — nothing to clear
          }
          // The slice anchor and pre-deletion snapshots go with it: their
          // blobs are review state too. refs/review-notes/<branch>
          // deliberately does not.
          await deleteSliceRef(activeGit, clearedBranch);
          await deletePreDeletionRef(activeGit, clearedBranch);
        });
        // Those slices are unanchored now, so the cache may not hand them to
        // the refresh below — it writes them, and the ref, again
        sliceCache.clear();
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

  // Test hook for the scripted extension-host check. Rendered comment threads
  // and tree row descriptions cannot be read back through the public API, so
  // the check reads them from here. Registered only under
  // DELTA_REVIEW_TEST=1 and deliberately absent from package.json's
  // contributes.commands, so no shipped build exposes it.
  if (process.env.DELTA_REVIEW_TEST === "1") {
    const collectTreeRows = (element?: ReviewTreeElement): unknown[] =>
      treeProvider.getChildren(element).flatMap((child) => {
        const item = treeProvider.getTreeItem(child);
        const label =
          typeof item.label === "string"
            ? item.label
            : (item.label?.label ??
              (item.resourceUri === undefined
                ? undefined
                : basename(item.resourceUri.path)));
        const icon =
          item.iconPath instanceof vscode.ThemeIcon ? item.iconPath : undefined;
        return [
          {
            id: item.id,
            label,
            description: item.description,
            icon: icon?.id,
            iconColor: icon?.color?.id,
            query: item.resourceUri?.query,
            commandUri:
              item.command?.arguments?.[0] instanceof vscode.Uri
                ? item.command.arguments[0].toString()
                : undefined,
          },
          ...collectTreeRows(child),
        ];
      });
    context.subscriptions.push(
      vscode.commands.registerCommand("deltaReview.__inspect", () => {
        const files = model?.files ?? [];
        return {
          files,
          threads: commentController.provenanceThreads(),
          agentLineThreads: commentController.agentLineThreads(),
          // Row text as tree mode renders it (no directory text), by path
          rows: Object.fromEntries(
            files.map((file) => [
              file.path,
              buildRowDescription({
                path: file.path,
                directoryText: undefined,
                movedFrom: file.movedFrom,
                moveOrigin: file.moveOrigin,
                donor: file.donor,
                moveClassification: file.moveClassification,
                originLines: file.originLines,
              }),
            ]),
          ),
          notesBadge: notesTreeView.badge,
          clusterChangesTabs: Object.fromEntries(clusterChangesTabs),
          treeRows: collectTreeRows(),
          commentableDocuments: commentController.commentableDocuments(),
          base: baseResolution,
          baseStatus: {
            text: baseStatusItem.text,
            tooltip: baseStatusItem.tooltip,
            visible: baseStatusVisible,
            command: baseStatusItem.command,
          },
          treeMessage: treeView.message,
          publishCount,
        };
      }),
    );
  }

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
    const lastHead = new Map<GitRepository, string>();
    const trackRepository = (repository: GitRepository): void => {
      lastHead.set(repository, headFingerprint(repository.state.HEAD));
      repoListeners.set(repository, [
        repository.ui.onDidChange(syncActiveRepo),
        // HEAD changes (branch switch, commit) live outside the worktree in
        // linked worktrees, so the file watcher misses them. Other state
        // events are skipped: our own review-ref writes fire them too.
        repository.state.onDidChange(() => {
          if (repository.rootUri.fsPath !== git?.repoRoot) {
            return;
          }
          const fingerprint = headFingerprint(repository.state.HEAD);
          if (fingerprint !== lastHead.get(repository)) {
            lastHead.set(repository, fingerprint);
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
        lastHead.delete(repository);
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
