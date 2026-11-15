work on the following 2 tasks.

1. [infra] let a moved file inherit its delta review when the origin was split or existed on main

delta-review repo. Since v0.11.0 a declared whole-file move inherits the old path's reviewed snapshot, but two rules in selectReviewSnapshot (src/model.ts) block it: the origin is "shared" when extraction entries name the same from, and the origin is still in the review set when the file existed on main and shows as a deletion. On feat/dev-speed these blocked about 19 of 110 declared moves. Count only whole-file moves when checking for a shared origin, and allow inheriting from a path whose only change is its deletion.delta-review repo. Since v0.11.0 a declared whole-file move inherits the old path's reviewed snapshot, but two rules in selectReviewSnapshot (src/model.ts) block it: the origin is "shared" when extraction entries name the same from, and the origin is still in the review set when the file existed on main and shows as a deletion. On feat/dev-speed these blocked about 19 of 110 declared moves. Count only whole-file moves when checking for a shared origin, and allow inheriting from a path whose only change is its deletion.

2. [feat] show one combined delta review diff of what changed in a cluster since it was marked reviewed

delta-review repo. A cleanup pass often touches five or six files in a finished cluster by a line or two each. Today each opens separately with its own "since my review" diff. One combined view per cluster would make that a single short read. Low priority: a convenience, not a gap.
