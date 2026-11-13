#!/usr/bin/env python3
"""Plan or create the four directories in a caller-identified paper branch."""
import argparse
import json
from pathlib import Path
import stat
import sys
import unicodedata

CHILDREN = ("论文原文", "配图", "解释", "问答")


def checked_directory(path):
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
        raise ValueError(f"拒绝使用非目录或符号链接：{path}")
    return True


def ensure(vault, paper, apply=False):
    if (not paper or paper != paper.strip() or paper in (".", "..")
            or paper.endswith(".")
            or any(c in '/\\:*?"<>|[]#^' or unicodedata.category(c).startswith("C") for c in paper)):
        raise ValueError("论文分支名必须是单个有效文件夹名，不能含路径、控制或链接冲突字符。")
    base = Path(vault).expanduser().absolute()
    # Reject links in each supplied vault path component, including broken links.
    for part in reversed((base, *base.parents)):
        if not checked_directory(part):
            raise ValueError(f"知识库路径不存在：{part}")
    if not checked_directory(base / ".obsidian"):
        raise ValueError("目标缺少有效的 .obsidian 目录。")
    papers = base / "论文阅读"
    branch = papers / paper
    targets = (papers, branch, *(branch / name for name in CHILDREN))
    present = {p: checked_directory(p) for p in targets}
    results = []
    for path in targets:
        existed = present[path]
        if apply and not existed:
            try:
                path.mkdir()
            except FileExistsError:
                checked_directory(path)
                existed = True
        results.append({"path": str(path), "status": "exists" if existed else "created" if apply else "would_create"})
    return {"mode": "apply" if apply else "plan", "branch": str(branch), "directories": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--paper", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        result = ensure(args.vault, args.paper, args.apply)
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
