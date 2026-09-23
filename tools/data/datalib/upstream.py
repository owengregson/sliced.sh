"""The pinned upstream clones the export scripts build from (git-ignored under
`tools/data/upstream/`)."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


def git_head(upstream: Path) -> str:
    return subprocess.run(["git", "-C", str(upstream), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()


def ensure_clone(repo: str, upstream: Path, commit: str, extra_env: dict[str, str] | None = None) -> None:
    """Clone `repo` into `upstream` if absent and check out exactly `commit`, or exit."""
    env = dict(os.environ, **(extra_env or {}))
    if not (upstream / ".git").exists():
        upstream.parent.mkdir(parents=True, exist_ok=True)
        print(f"cloning {repo} → {upstream}")
        subprocess.run(["git", "clone", "--quiet", repo, str(upstream)], check=True, env=env)
    head = git_head(upstream)
    if head != commit:
        subprocess.run(["git", "-C", str(upstream), "fetch", "--quiet", "origin", commit], check=False, env=env)
        subprocess.run(["git", "-C", str(upstream), "checkout", "--quiet", commit], check=True, env=env)
        head = git_head(upstream)
    if head != commit:
        raise SystemExit(f"upstream is at {head}, expected {commit}")
    print(f"upstream {repo} @ {commit}")
