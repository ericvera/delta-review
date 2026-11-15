Consider the following. You alone are responsible for this repo so take the task details as informational.

Title: [infra] carry delta review state across renames so a renamed file diffs against its reviewed version

Description: 

delta-review repo. The "since my review" diff already ships, but the reviewed snapshot is looked up by the file's own path (resolveFileBase in src/model.ts). A file renamed on the branch, whether git found the rename or the contract declared it, loses its review state and diffs against the merge base or the origin's merge-base blob.

Wanted: when a rename or declared repo move links old → new, use the old path's reviewed snapshot as the diff base.

Optional: let a repo move set its base to an in-branch version. Today baseBlob on a repo move is dropped unless it declares extraction (src/clusters.ts).

Workaround today, though it bends the contract: declare the rename as an external move with baseBlob = the reviewed version.

Source: feat/pop-up-config review, where about 100 renamed or edited files went back into the queue.
