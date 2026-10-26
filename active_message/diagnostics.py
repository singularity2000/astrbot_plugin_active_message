"""结构化日志、异常摘要与有容量和时限的内存决策回放。"""
from __future__ import annotations

from .i18n import catalog, display_text

import copy
import json
import time
import traceback
from collections import OrderedDict
from .text_context import project
from typing import Any


class TraceStore:
    def __init__(self, options=None, secrets=()):
        options = options or {}
        self.capture_raw = True
        def bound(key, default, low, high):
            try: return min(high, max(low, int(options.get(key, default))))
            except (TypeError, ValueError): return default
        self.ttl = bound("retention_minutes", 1440, 1, 1440) * 60
        self.budget = bound("max_memory_mb", 64, 1, 128) * 1024 * 1024
        self.max_step_chars = bound("max_step_chars", 16000, 256, 1048576)
        self.secrets = tuple(secret for secret in secrets if isinstance(secret, str) and secret)
        self.runs = OrderedDict()
        self.sizes = {}
        # Active summaries refer to already-running tasks. Unlike step history,
        # they remain available while a slow native model is still working.
        self.live = {}
        self.latest_results = {}

    def clear(self):
        self.runs.clear()
        self.sizes.clear()
        self.latest_results.clear()

    def watch(self, run_id, sid, kind, snapshot, *, source=None):
        kind = {"智能插话": "interjection", "主动聊天": "proactive"}.get(kind, kind)
        self.live[run_id] = {"sid": sid, "kind": kind,
                             "created_at": self.runs.get(run_id, {}).get("created_at", time.time()),
                             "source": source or self.runs.get(run_id, {}).get("source"),
                             "snapshot": snapshot}

    def _active_run(self, run_id):
        live = self.live.get(run_id)
        if live is None:
            return None
        return {"run_id": run_id, "sid": live["sid"], "kind": live["kind"], "source": live.get("source"),
                "created_at": live["created_at"], "status": "进行中", "result": "running", "sent": False, "error": False, "steps": [],
                "raw_enabled": self.capture_raw, "history_omitted": True}

    def _summary(self, run):
        result = {k: v for k, v in run.items() if k != "steps"}
        live = self.live.get(run["run_id"])
        if live is not None:
            result["progress"] = live["snapshot"]()
            if result["progress"].get("sent"):
                result.update(sent=True, status="已发送，仍在处理")
        return result

    def _prune(self):
        now = time.time()
        for key in list(self.runs):
            if key not in self.live and now - self.runs[key].get("finished_at", self.runs[key]["created_at"]) > self.ttl:
                self.runs.pop(key, None); self.sizes.pop(key, None)
        while sum(self.sizes.values()) > self.budget:
            key, _ = self.runs.popitem(last=False)
            self.sizes.pop(key, None)

    def begin(self, run_id, sid, kind, *, source=None):
        kind = {"智能插话": "interjection", "主动聊天": "proactive", "收到消息": "other"}.get(kind, kind)
        if run_id in self.runs:
            self.runs[run_id].update(status="进行中", result="running", kind=kind, error=False)
            return
        self.runs[run_id] = {"run_id":run_id, "sid":sid, "kind":kind, "created_at":time.time(),
                             "status":"进行中", "result":"running", "sent":False, "error":False,
                             "steps":[], "raw_enabled":self.capture_raw}
        self.sizes[run_id] = 512
        if source is not None:
            self.runs[run_id]["source"] = source
        self._prune()

    def _safe_json(self, data):
        def clean(value, depth=0):
            if depth > 24:
                return "[嵌套过深，已省略]"
            if isinstance(value, dict):
                return {str(k): "[凭据已隐藏]" if str(k).lower() in {"authorization", "api_key", "jev_api_key", "password", "token"} else clean(v, depth + 1) for k,v in value.items()}
            if isinstance(value, (list, tuple)): return [clean(v, depth + 1) for v in value]
            if isinstance(value, str):
                for secret in self.secrets:
                    value = value.replace(secret, "[凭据已隐藏]")
            return value
        chunks, used = [], 0
        encoder = json.JSONEncoder(ensure_ascii=False, default=str)
        for chunk in encoder.iterencode(project(clean(data), self.max_step_chars)):
            take = self.max_step_chars + 1 - used
            chunks.append(chunk[:take])
            used += len(chunks[-1])
            if used > self.max_step_chars:
                break
        return "".join(chunks)

    def add(self, run_id, label, data=None, *, raw=False, terminal=False, key=None, tone="neutral"):
        label = display_text(label)
        self._prune()
        run = self.runs.get(run_id)
        if run is None and terminal:
            run = self._active_run(run_id)
            if run is not None:
                self.runs[run_id] = run
                self.sizes[run_id] = 512
        if not run: return
        existing = next((i for i, step in enumerate(run["steps"]) if step.get("key") == key), None) if key else None
        previous = run["steps"][existing] if existing is not None else None
        previous_size = len(json.dumps(previous, ensure_ascii=False).encode("utf-8")) + 128 if previous else 0
        if previous:
            if isinstance(previous.get("data"), dict) and isinstance(data, dict):
                data = {**previous["data"], **data}
            if tone == "neutral":
                tone = previous.get("tone", tone)
        if existing is None and len(run["steps"]) >= (1000 if terminal else 997):
            run["steps_omitted"] = run.get("steps_omitted", 0) + 1
            if not terminal:
                return
            # Preserve the final failure/summary even after a long tool loop.
            removed = run["steps"].pop()
            self.sizes[run_id] -= len(json.dumps(removed, ensure_ascii=False).encode("utf-8")) + 128
        step = {"label":label, "at":previous["at"] if previous else time.time(), "raw":raw,
                "tone":tone, "key":key, "updated_at":time.time()}
        text = self._safe_json(data)
        shortened = len(text) > self.max_step_chars
        safe_data = {"preview": text[:self.max_step_chars], "shortened": True, "projected_chars_at_least": len(text)} if shortened else json.loads(text)
        size = len(json.dumps(safe_data, ensure_ascii=False).encode("utf-8"))
        if size + self.sizes.get(run_id, 0) - previous_size + 512 > self.budget:
            step.update(state="超过容量，未保留正文", bytes=size)
        else:
            step.update(state="文字预览已缩减" if shortened else "已记录文字（媒体编码与已知凭据已隐藏）", data=safe_data)
        if existing is None:
            run["steps"].append(step)
        else:
            run["steps"][existing] = step
        self.sizes[run_id] += len(json.dumps(step, ensure_ascii=False).encode("utf-8")) + 128 - previous_size
        self._prune()

    def finish(self, run_id, status, *, result="quiet", sent=False, error=False, kind=None):
        status = display_text(status)
        if run_id not in self.runs:
            active = self._active_run(run_id)
            if active is not None:
                self.runs[run_id] = active
                self.sizes[run_id] = 512
        self.live.pop(run_id, None)
        if run_id in self.runs:
            self.runs[run_id]["status"] = status
            self.runs[run_id].update(result=result, sent=sent, error=error)
            if kind:
                self.runs[run_id]["kind"] = kind
            self.runs[run_id]["finished_at"] = time.time()
            run = self.runs[run_id]
            if run["kind"] in {"interjection", "proactive"} and result != "running":
                if len(self.latest_results) >= 500 and run["sid"] not in self.latest_results:
                    self.latest_results.pop(next(iter(self.latest_results)))
                self.latest_results.setdefault(run["sid"], {})[run["kind"]] = {
                    key: run[key] for key in ("run_id", "kind", "status", "result", "sent", "error", "finished_at")}
            self._prune()

    def list(self):
        self._prune()
        runs = dict(self.runs)
        runs.update({key: self._active_run(key) for key in self.live if key not in runs})
        return [self._summary(run) for run in sorted(runs.values(), key=lambda r: r["created_at"], reverse=True)]

    def describe(self, run_id):
        self._prune()
        run = self.runs.get(run_id) or self._active_run(run_id)
        if run is None:
            return None
        return {**self._summary(run),
                "steps": [{**{k: v for k, v in step.items() if k != "data"}, "has_data": "data" in step}
                          for step in run["steps"]]}

    def step(self, run_id, index):
        self._prune()
        run = self.runs.get(run_id)
        if not run or index < 0 or index >= len(run["steps"]):
            return None
        return copy.deepcopy(run["steps"][index])

    def get(self, run_id):
        self._prune()
        return copy.deepcopy(self.runs.get(run_id))


MESSAGES = {code: row["message"] for code, row in catalog()["diagnostics"].items()}

# The console shows the explanation and the relevant setting beside the event.
# Codes/field names remain available in the expandable technical details.
DIAGNOSTIC_ACTIONS = {code: (row["action"], row["tab"]) for code, row in catalog()["diagnostics"].items() if row["action"]}
REPEAT_CODES = {"COOLDOWN", "AGENT_ACTIVE", "PROVIDER_MISSING", "MODEL_TIMEOUT", "MODEL_INVALID",
                "MODEL_ERROR", "INPUT_TOO_LARGE", "JEV_HTTP", "JEV_CONFIG", "NO_CONVERSATION", "PROACTIVE_SKIPPED",
                "STATE_SAVE_FAILED", "SCHEDULER_FAILED"}


class Observability:
    """结构化、可分级的日志；从不写请求头、消息原文或完整人设。"""

    def __init__(self, logger: Any) -> None:
        self.logger = logger
        self.sink = None
        self.latest: dict[str, dict[str, Any]] = {}
        self._emitted: dict[tuple, tuple[float, int]] = {}

    def log(self, level: str, code: str, **fields: Any) -> None:
        record = {"code": code, "level": level, "message": MESSAGES.get(code, code), **fields}
        if self.sink is not None:
            self.sink(record)
        sid = fields.get("sid")
        if isinstance(sid, str):
            if len(self.latest) >= 500 and sid not in self.latest:
                self.latest.pop(next(iter(self.latest)))
            self.latest[sid] = record
        if code in REPEAT_CODES:
            key = (sid, code)
            now = time.monotonic()
            last, suppressed = self._emitted.get(key, (-float("inf"), 0))
            if now - last < 60:
                self._emitted[key] = (last, suppressed + 1)
                return
            if len(self._emitted) >= 2000:
                self._emitted.clear()
            self._emitted[key] = (now, 0)
            if suppressed:
                record["suppressed_repeats"] = suppressed
        getattr(self.logger, level)("[主动会话] %s", json.dumps(record, ensure_ascii=False, default=str))

    def error(self, code: str, exc: BaseException, **fields: Any) -> None:
        # Exception messages can contain full LLM payloads/API keys. Keep only
        # exception type and stack locations; never stringify the exception.
        self.log("error", code, **exception_details(exc), **fields)


def exception_details(exc: BaseException) -> dict[str, Any]:
    """Keep cancellation causes and safe status codes, never exception bodies."""
    chain, seen = [], set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen and len(chain) < 8:
        seen.add(id(current))
        item = {"exception": type(current).__name__, "stack": [
            {"file": frame.filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1],
             "line": frame.lineno, "function": frame.name}
            for frame in traceback.extract_tb(current.__traceback__)[-24:]
        ]}
        status = getattr(current, "status_code", None)
        if status is None:
            status = getattr(current, "status", None)
        if status is None:
            status = getattr(getattr(current, "response", None), "status_code", None)
        if type(status) is int and 100 <= status <= 599:
            item["http_status"] = status
        chain.append(item)
        current = current.__cause__ or (None if current.__suppress_context__ else current.__context__)
    return {**chain[0], "causes": chain[1:]}
