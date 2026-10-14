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
