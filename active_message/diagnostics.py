"""有容量和时限的内存诊断。原文需主动开启，不写成长期聊天日志。"""
from __future__ import annotations
import copy
import json
import time
from collections import OrderedDict
from .text_context import project


class TraceStore:
    def __init__(self, options=None, secrets=()):
        options = options or {}
        self.capture_raw = bool(options.get("capture_raw", False))
        def bound(key, default, low, high):
            try: return min(high, max(low, int(options.get(key, default))))
            except (TypeError, ValueError): return default
        self.max_runs = bound("max_runs", 50, 1, 500)
        self.ttl = bound("retention_minutes", 30, 1, 1440) * 60
        self.budget = bound("max_memory_mb", 10, 1, 128) * 1024 * 1024
        self.max_step_chars = bound("max_step_chars", 16000, 256, 1048576)
        self.secrets = tuple(secret for secret in secrets if isinstance(secret, str) and secret)
        self.runs = OrderedDict()
        self.sizes = {}

    def clear(self):
        self.runs.clear()
        self.sizes.clear()

    def _prune(self):
        now = time.time()
        for key in list(self.runs):
            if now - self.runs[key]["created_at"] > self.ttl:
                self.runs.pop(key, None); self.sizes.pop(key, None)
        while len(self.runs) > self.max_runs or sum(self.sizes.values()) > self.budget:
            key, _ = self.runs.popitem(last=False)
            self.sizes.pop(key, None)

    def begin(self, run_id, sid, kind):
        if run_id in self.runs:
            self.runs[run_id].update(status="进行中", kind=kind)
            return
        self.runs[run_id] = {"run_id":run_id, "sid":sid, "kind":kind, "created_at":time.time(),
                             "status":"进行中", "steps":[], "raw_enabled":self.capture_raw}
        self.sizes[run_id] = 512
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

    def add(self, run_id, label, data=None, *, raw=False):
        self._prune()
        run = self.runs.get(run_id)
        if not run: return
        if len(run["steps"]) >= 100:
            run["steps_omitted"] = run.get("steps_omitted", 0) + 1
            return
        step = {"label":label, "at":time.time(), "raw":raw}
        if raw and not self.capture_raw:
            step.update(state="未开启文字快照采集")
        else:
            text = self._safe_json(data)
            shortened = len(text) > self.max_step_chars
            safe_data = {"preview": text[:self.max_step_chars], "shortened": True, "projected_chars_at_least": len(text)} if shortened else json.loads(text)
            size = len(json.dumps(safe_data, ensure_ascii=False).encode("utf-8"))
            if size + self.sizes.get(run_id, 0) + 512 > self.budget:
                step.update(state="超过容量，未保留正文", bytes=size)
            else:
                step.update(state="文字预览已缩减" if shortened else "已记录文字（媒体编码与已知凭据已隐藏）", data=safe_data)
        run["steps"].append(step)
        self.sizes[run_id] += len(json.dumps(step, ensure_ascii=False).encode("utf-8")) + 128
        self._prune()

    def finish(self, run_id, status):
        if run_id in self.runs:
            self.runs[run_id]["status"] = status
            self.runs[run_id]["finished_at"] = time.time()

    def list(self):
        self._prune()
        return [{k:v for k,v in run.items() if k != "steps"} for run in reversed(self.runs.values())]

    def describe(self, run_id):
        self._prune()
        run = self.runs.get(run_id)
        if run is None:
            return None
        return {**{k: v for k, v in run.items() if k != "steps"},
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
