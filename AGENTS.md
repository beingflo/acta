# AGENTS.md

## Version control: read-only

This repository is version-controlled with **Jujutsu (`jj`)**, colocated with Git.

**Never perform any mutable version-control operation.** The user owns all history changes and commits.

Forbidden — including, but not limited to:

- `git`: `commit`, `add`, `stage`, `rm`, `mv`, `checkout`, `switch`, `restore`, `reset`, `revert`, `stash`,
  `merge`, `rebase`, `cherry-pick`, `push`, `pull`, `fetch`, `tag`, `branch`, `remote`, `init`, `gc`, `clean`
- `jj`: `commit`, `describe`, `new`, `edit`, `squash`, `split`, `abandon`, `rebase`, `bookmark`, `git`, `undo`,
  `restore`, `op`, `squash`
- Any command that writes to `.git/` or `.jj/`

Allowed — reading is always fine:

- `git log`, `git show`, `git diff`, `git status`, `git blame`, `git ls-files`
- `jj log`, `jj diff`, `jj status`, `jj show`, `jj file list`

If a change seems to warrant a commit, make the file edits and tell the user; do not commit.

## Design docs

`design/*.md` and `PLAN.md` describe the system at a high level. **Keep them in sync with the application.** When a
change alters something a doc describes — schema, storage layout, API, query rules, dashboards, URL scheme, phases —
update the relevant doc in the same piece of work.

Keep doc edits crisp and high-level. State what the system does and why, not implementation detail the code already
holds. Prefer correcting or trimming existing text over adding new sections.
