import * as vscode from "vscode";
import {
  type BaseResolution,
  clearBranchBase,
  isRefValid,
  listLocalBranches,
  writeBranchBase,
} from "./diffBase";
import { basePickerEntries, type PickerEntry } from "./diffBaseUi";
import type { Git } from "./git";

export type BasePickerOutcome =
  | { outcome: "picked"; ref: string }
  | { outcome: "cleared" }
  | { outcome: "cancelled" };

type Action =
  | { kind: "ref"; ref: string }
  | { kind: "typed"; ref: string }
  | { kind: "enterRef" }
  | { kind: "automatic" };

interface PickerItem extends vscode.QuickPickItem {
  action?: Action;
}

const invalidRefMessage = (ref: string): string =>
  `'${ref}' is not a valid ref in this repository.`;

const toItem = (entry: PickerEntry): PickerItem => {
  switch (entry.kind) {
    case "separator":
      return { label: entry.label, kind: vscode.QuickPickItemKind.Separator };
    case "ref":
      return {
        label: entry.label,
        description: entry.description,
        action: { kind: "ref", ref: entry.ref },
      };
    case "enterRef":
      return {
        label: "$(edit) Enter a ref…",
        description: "tag, remote branch, or commit",
        action: { kind: "enterRef" },
      };
    case "automatic":
      return {
        label: "$(discard) Use automatic detection",
        description: "clears the explicit base",
        action: { kind: "automatic" },
      };
  }
};

const promptForRef = async (
  git: Git,
  branch: string,
): Promise<string | undefined> => {
  const typed = await vscode.window.showInputBox({
    prompt: `Ref to diff ${branch} against (press Enter to confirm, Escape to cancel)`,
    ignoreFocusOut: true,
    validateInput: async (value) => {
      const ref = value.trim();
      if (ref.length === 0) {
        return undefined;
      }
      return (await isRefValid(git, ref)) ? undefined : invalidRefMessage(ref);
    },
  });
  const ref = typed?.trim();
  if (ref === undefined || ref.length === 0 || !(await isRefValid(git, ref))) {
    return undefined;
  }
  return ref;
};

export const showBasePicker = async (options: {
  git: Git;
  resolution: BaseResolution;
  preferFirst?: string;
}): Promise<BasePickerOutcome> => {
  const { git, resolution, preferFirst } = options;
  const { branch } = resolution;
  const entries = basePickerEntries(resolution, await listLocalBranches(git), {
    preferFirst,
  });
  const baseItems = entries.map(toItem);
  const knownRefs = entries.flatMap((entry) =>
    entry.kind === "ref" ? [entry.ref] : [],
  );

  const quickPick = vscode.window.createQuickPick<PickerItem>();
  quickPick.title = `Diff base for ${branch}`;
  quickPick.placeholder = "Select a base branch or type a ref";
  quickPick.items = baseItems;
  quickPick.ignoreFocusOut = true;

  const action = await new Promise<Action | undefined>((resolve) => {
    let settled = false;
    const settle = (value: Action | undefined): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    quickPick.onDidChangeValue((value) => {
      const typed = value.trim();
      if (typed.length === 0 || knownRefs.includes(typed)) {
        quickPick.items = baseItems;
        return;
      }
      const typedItem: PickerItem = {
        label: `Use ref '${typed}'`,
        alwaysShow: true,
        action: { kind: "typed", ref: typed },
      };
      quickPick.items = [...baseItems, typedItem];
      // Replacing items resets the active item; keep Enter on a branch the
      // filter still shows, falling back to the typed ref
      const needle = typed.toLowerCase();
      const match = baseItems.find(
        (item) =>
          item.action?.kind === "ref" &&
          item.action.ref.toLowerCase().includes(needle),
      );
      quickPick.activeItems = [match ?? typedItem];
    });
    quickPick.onDidAccept(async () => {
      const chosen = quickPick.selectedItems[0]?.action;
      if (chosen === undefined) {
        return;
      }
      if (chosen.kind === "typed") {
        quickPick.busy = true;
        const valid = await isRefValid(git, chosen.ref);
        quickPick.busy = false;
        if (!valid) {
          void vscode.window.showErrorMessage(invalidRefMessage(chosen.ref));
          return;
        }
      }
      settle(chosen);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      settle(undefined);
      quickPick.dispose();
    });
    quickPick.show();
  });

  if (action === undefined) {
    return { outcome: "cancelled" };
  }
  if (action.kind === "automatic") {
    await clearBranchBase(git, branch);
    return { outcome: "cleared" };
  }
  const ref =
    action.kind === "enterRef" ? await promptForRef(git, branch) : action.ref;
  if (ref === undefined) {
    return { outcome: "cancelled" };
  }
  await writeBranchBase(git, branch, ref);
  return { outcome: "picked", ref };
};
