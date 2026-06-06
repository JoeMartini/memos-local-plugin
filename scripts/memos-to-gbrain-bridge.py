#!/usr/bin/env python3
"""
MemOS ↔ gbrain Bridge — 双向记忆同步工具

功能:
  1. 从 MemOS SQLite 导出高价值记忆（traces/policies/skills）为 Markdown
  2. 导入到 gbrain 作为参考知识库
  3. 可选：从 gbrain 导出知识笔记到 MemOS（未来扩展）

设计原则:
  • 不侵入 MemOS 或 gbrain 源码
  • 纯 Python + sqlite3，零外部依赖
  • 按 profile 隔离内容
  • 幂等执行（重复运行不造成重复导入）

用法:
  python3 memos-to-gbrain-bridge.py [--dry-run] [--profiles PROFILE1,PROFILE2]

环境:
  GBRAIN_HOME    gbrain 安装路径 (默认: ~/gbrain)
  MEMOS_HOME     MemOS 数据路径 (默认: ~/.hermes/memos-plugin)
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


# ─── 配置 ───────────────────────────────────────────────────────────────────

DEFAULT_GBRAIN_HOME = Path.home() / "gbrain"
DEFAULT_MEMOS_HOME = Path.home() / ".hermes" / "memos-plugin"
DEFAULT_OUT_DIR = DEFAULT_MEMOS_HOME / "scripts" / "export"
BRIDGE_STATE_FILE = DEFAULT_MEMOS_HOME / "scripts" / ".bridge_state.json"

GBRAIN_MIN_VALUE = 0.3          # 只导出 V 值 >= 此阈值的记忆
GBRAIN_MIN_PRIORITY = 0.2       # 只导出 priority >= 此阈值的记忆
GBRAIN_POLICY_MIN_GAIN = 0.1    # 只导出 gain >= 此阈值的策略
GBRAIN_SKILL_MIN_ETA = 0.3      # 只导出 eta >= 此阈值的技能


# ─── 工具函数 ───────────────────────────────────────────────────────────────

def _ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def _ts_to_iso(ts: int | None) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()
    except Exception:
        return ""


def _json_loads(s: str | None) -> list | dict:
    if not s:
        return []
    try:
        return json.loads(s)
    except Exception:
        return []


# ─── MemOS 读取 ─────────────────────────────────────────────────────────────

class MemosExporter:
    def __init__(self, db_path: Path):
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row

    def close(self):
        self.conn.close()

    def get_profiles(self) -> list[str]:
        cur = self.conn.cursor()
        cur.execute(
            "SELECT DISTINCT owner_profile_id FROM traces "
            "WHERE owner_profile_id IS NOT NULL AND owner_profile_id != '' "
            "UNION "
            "SELECT DISTINCT owner_profile_id FROM policies "
            "WHERE owner_profile_id IS NOT NULL AND owner_profile_id != '' "
            "UNION "
            "SELECT DISTINCT owner_profile_id FROM skills "
            "WHERE owner_profile_id IS NOT NULL AND owner_profile_id != ''"
        )
        return [row[0] for row in cur.fetchall()]

    def get_high_value_traces(self, profile_id: str, min_value: float = 0.3, min_priority: float = 0.2):
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT id, episode_id, ts, user_text, agent_text, summary,
                   reflection, value, alpha, r_human, priority, tags_json,
                   tool_calls_json, error_signatures_json
            FROM traces
            WHERE owner_profile_id = ?
              AND (COALESCE(value, 0) >= ? OR COALESCE(priority, 0) >= ?)
            ORDER BY ts DESC
            LIMIT 200
            """,
            (profile_id, min_value, min_priority),
        )
        return cur.fetchall()

    def get_active_policies(self, profile_id: str, min_gain: float = 0.1):
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT id, title, trigger, procedure, verification, boundary,
                   support, gain, status, confidence, salience,
                   source_episodes_json, created_at, updated_at
            FROM policies
            WHERE owner_profile_id = ?
              AND status = 'active'
              AND COALESCE(gain, 0) >= ?
            ORDER BY gain DESC
            LIMIT 100
            """,
            (profile_id, min_gain),
        )
        return cur.fetchall()

    def get_crystallized_skills(self, profile_id: str, min_eta: float = 0.3):
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT id, name, status, invocation_guide, procedure_json,
                   eta, support, gain, trials_attempted, trials_passed,
                   source_policies_json, created_at, updated_at, version
            FROM skills
            WHERE owner_profile_id = ?
              AND status IN ('active', 'probationary')
              AND COALESCE(eta, 0) >= ?
            ORDER BY eta DESC
            LIMIT 50
            """,
            (profile_id, min_eta),
        )
        return cur.fetchall()


# ─── Markdown 格式化 ────────────────────────────────────────────────────────

def _frontmatter(meta: dict) -> str:
    lines = ["---"]
    for k, v in meta.items():
        if v is None:
            continue
        if isinstance(v, list):
            lines.append(f"{k}:")
            for item in v:
                lines.append(f"  - {item}")
        else:
            lines.append(f"{k}: {v}")
    lines.append("---")
    lines.append("")
    return "\n".join(lines)


def format_trace_md(row: sqlite3.Row) -> str:
    meta = {
        "id": f"memos-trace-{row['id']}",
        "type": "memos_trace",
        "source": "MemOS L1 Trace",
        "episode_id": row["episode_id"],
        "timestamp": _ts_to_iso(row["ts"]),
        "value": row["value"],
        "alpha": row["alpha"],
        "r_human": row["r_human"],
        "priority": row["priority"],
        "tags": _json_loads(row["tags_json"]),
    }
    body_parts = []
    if row["summary"]:
        body_parts.append(f"## Summary\n\n{row['summary']}")
    if row["user_text"]:
        body_parts.append(f"## User\n\n{row['user_text']}")
    if row["agent_text"]:
        body_parts.append(f"## Agent\n\n{row['agent_text']}")
    if row["reflection"]:
        body_parts.append(f"## Reflection\n\n{row['reflection']}")
    tools = _json_loads(row["tool_calls_json"])
    if tools:
        body_parts.append(f"## Tools\n\n```json\n{json.dumps(tools, ensure_ascii=False, indent=2)}\n```")
    errors = _json_loads(row["error_signatures_json"])
    if errors:
        body_parts.append(f"## Errors\n\n```json\n{json.dumps(errors, ensure_ascii=False, indent=2)}\n```")

    body = "\n\n".join(body_parts) if body_parts else "*(no content)*"
    return _frontmatter(meta) + body + "\n"


def format_policy_md(row: sqlite3.Row) -> str:
    meta = {
        "id": f"memos-policy-{row['id']}",
        "type": "memos_policy",
        "source": "MemOS L2 Policy",
        "title": row["title"],
        "status": row["status"],
        "gain": row["gain"],
        "support": row["support"],
        "confidence": row["confidence"],
        "salience": row["salience"],
        "created_at": _ts_to_iso(row["created_at"]),
        "updated_at": _ts_to_iso(row["updated_at"]),
    }
    body_parts = []
    if row["trigger"]:
        body_parts.append(f"## Trigger\n\n{row['trigger']}")
    if row["procedure"]:
        body_parts.append(f"## Procedure\n\n{row['procedure']}")
    if row["verification"]:
        body_parts.append(f"## Verification\n\n{row['verification']}")
    if row["boundary"]:
        body_parts.append(f"## Boundary\n\n{row['boundary']}")
    episodes = _json_loads(row["source_episodes_json"])
    if episodes:
        body_parts.append(f"## Source Episodes\n\n{', '.join(episodes)}")

    body = "\n\n".join(body_parts) if body_parts else "*(no content)*"
    return _frontmatter(meta) + body + "\n"


def format_skill_md(row: sqlite3.Row) -> str:
    meta = {
        "id": f"memos-skill-{row['id']}",
        "type": "memos_skill",
        "source": "MemOS Crystallized Skill",
        "name": row["name"],
        "status": row["status"],
        "eta": row["eta"],
        "support": row["support"],
        "gain": row["gain"],
        "trials": f"{row['trials_passed'] or 0}/{row['trials_attempted'] or 0}",
        "version": row["version"],
        "created_at": _ts_to_iso(row["created_at"]),
        "updated_at": _ts_to_iso(row["updated_at"]),
    }
    body_parts = []
    if row["invocation_guide"]:
        body_parts.append(f"## Invocation Guide\n\n{row['invocation_guide']}")
    proc = _json_loads(row["procedure_json"])
    if proc:
        body_parts.append(f"## Procedure\n\n```json\n{json.dumps(proc, ensure_ascii=False, indent=2)}\n```")
    policies = _json_loads(row["source_policies_json"])
    if policies:
        body_parts.append(f"## Source Policies\n\n{', '.join(policies)}")

    body = "\n\n".join(body_parts) if body_parts else "*(no content)*"
    return _frontmatter(meta) + body + "\n"


# ─── gbrain 导入 ────────────────────────────────────────────────────────────

def gbrain_import(gbrain_home: Path, source_dir: Path) -> bool:
    """调用 gbrain import 命令导入 Markdown 目录。"""
    env = os.environ.copy()
    env["PATH"] = f"{Path.home() / '.bun/bin'}:{env.get('PATH', '')}"
    env_file = gbrain_home / ".env"
    if env_file.exists():
        with open(env_file) as f:
            for line in f:
                if "=" in line and not line.startswith("#"):
                    k, v = line.strip().split("=", 1)
                    env[k] = v

    cmd = ["bun", "src/cli.ts", "import", str(source_dir), "--no-embed"]
    try:
        result = subprocess.run(
            cmd,
            cwd=str(gbrain_home),
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode == 0:
            print(f"  [gbrain] import OK: {source_dir}")
            return True
        else:
            print(f"  [gbrain] import FAILED (rc={result.returncode}):")
            print(result.stderr or result.stdout)
            return False
    except Exception as e:
        print(f"  [gbrain] import ERROR: {e}")
        return False


# ─── 桥接主逻辑 ─────────────────────────────────────────────────────────────

def run_bridge(
    memos_home: Path,
    gbrain_home: Path,
    out_dir: Path,
    profiles: list[str] | None,
    dry_run: bool = False,
) -> dict:
    db_path = memos_home / "data" / "memos.db"
    if not db_path.exists():
        print(f"ERROR: MemOS DB not found: {db_path}")
        sys.exit(1)

    exporter = MemosExporter(db_path)
    all_profiles = exporter.get_profiles()
    target_profiles = [p for p in (profiles or all_profiles) if p in all_profiles]

    if not target_profiles:
        print("No matching profiles found in MemOS.")
        exporter.close()
        return {"total_exported": 0, "total_imported": 0}

    total_exported = 0
    total_imported = 0

    for profile in target_profiles:
        print(f"\n📁 Profile: {profile}")
        profile_dir = _ensure_dir(out_dir / profile)

        # 清理旧导出（保留当天）
        today = datetime.now().strftime("%Y-%m-%d")
        profile_today_dir = _ensure_dir(profile_dir / today)

        # 导出 traces
        traces_dir = _ensure_dir(profile_today_dir / "traces")
        traces = exporter.get_high_value_traces(profile, GBRAIN_MIN_VALUE, GBRAIN_MIN_PRIORITY)
        for row in traces:
            md = format_trace_md(row)
            (traces_dir / f"{row['id']}.md").write_text(md, encoding="utf-8")
        trace_count = len(traces)
        print(f"  Traces exported: {trace_count}")

        # 导出 policies
        policies_dir = _ensure_dir(profile_today_dir / "policies")
        policies = exporter.get_active_policies(profile, GBRAIN_POLICY_MIN_GAIN)
        for row in policies:
            md = format_policy_md(row)
            (policies_dir / f"{row['id']}.md").write_text(md, encoding="utf-8")
        policy_count = len(policies)
        print(f"  Policies exported: {policy_count}")

        # 导出 skills
        skills_dir = _ensure_dir(profile_today_dir / "skills")
        skills = exporter.get_crystallized_skills(profile, GBRAIN_SKILL_MIN_ETA)
        for row in skills:
            md = format_skill_md(row)
            (skills_dir / f"{row['id']}.md").write_text(md, encoding="utf-8")
        skill_count = len(skills)
        print(f"  Skills exported: {skill_count}")

        profile_total = trace_count + policy_count + skill_count
        total_exported += profile_total

        if profile_total == 0:
            print(f"  Nothing to export for {profile}")
            continue

        if not dry_run:
            # 导入到 gbrain
            ok = gbrain_import(gbrain_home, profile_today_dir)
            if ok:
                total_imported += profile_total
        else:
            print(f"  [DRY-RUN] Would import {profile_total} items to gbrain")

    exporter.close()

    # 更新状态文件
    state = {
        "last_run": datetime.now(timezone.utc).isoformat(),
        "profiles": target_profiles,
        "total_exported": total_exported,
        "total_imported": total_imported,
    }
    BRIDGE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    BRIDGE_STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")

    return state


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="MemOS ↔ gbrain 记忆桥接工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python3 memos-to-gbrain-bridge.py --dry-run
  python3 memos-to-gbrain-bridge.py --profiles martini
  python3 memos-to-gbrain-bridge.py
        """,
    )
    parser.add_argument("--dry-run", action="store_true", help="只导出，不导入到 gbrain")
    parser.add_argument("--profiles", help="逗号分隔的 profile 列表（默认：全部）")
    parser.add_argument("--memos-home", type=Path, default=DEFAULT_MEMOS_HOME)
    parser.add_argument("--gbrain-home", type=Path, default=DEFAULT_GBRAIN_HOME)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    args = parser.parse_args()

    profiles = [p.strip() for p in args.profiles.split(",")] if args.profiles else None

    print("=" * 60)
    print("🧠 MemOS ↔ gbrain Bridge")
    print(f"   MemOS: {args.memos_home}")
    print(f"   gbrain: {args.gbrain_home}")
    print(f"   Profiles: {', '.join(profiles) if profiles else 'all'}")
    print(f"   Mode: {'DRY-RUN' if args.dry_run else 'LIVE'}")
    print("=" * 60)

    state = run_bridge(
        memos_home=args.memos_home,
        gbrain_home=args.gbrain_home,
        out_dir=args.out_dir,
        profiles=profiles,
        dry_run=args.dry_run,
    )

    print("\n" + "=" * 60)
    print(f"✅ Done. Exported: {state['total_exported']}, Imported: {state['total_imported']}")
    print("=" * 60)


if __name__ == "__main__":
    main()
