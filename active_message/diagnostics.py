"""有容量和时限的内存诊断。原文需主动开启，不写成长期聊天日志。"""
from __future__ import annotations
import copy
import json
import time
from collections import OrderedDict


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
        def clean(value):
            if isinstance(value, dict):
                return {str(k): "[凭据已隐藏]" if str(k).lower() in {"authorization", "api_key", "jev_api_key", "password", "token"} else clean(v) for k,v in value.items()}
            if isinstance(value, (list, tuple)): return [clean(v) for v in value]
            if isinstance(value, str):
                for secret in self.secrets:
                    value = value.replace(secret, "[凭据已隐藏]")
            return value
        return json.dumps(clean(data), ensure_ascii=False, default=str)

    def add(self, run_id, label, data=None, *, raw=False):
        self._prune()
        run = self.runs.get(run_id)
        if not run: return
        if len(run["steps"]) >= 100:
            run["steps_omitted"] = run.get("steps_omitted", 0) + 1
            return
        step = {"label":label, "at":time.time(), "raw":raw}
        text = self._safe_json(data)
        size = len(text.encode("utf-8"))
        if raw and not self.capture_raw:
            step.update(state="未开启原文采集", bytes=size)
        elif size + self.sizes.get(run_id, 0) + 512 > self.budget:
            step.update(state="超过容量，未保留全文", bytes=size)
        else:
            step.update(state="已记录（已隐藏已知凭据）", data=json.loads(text))
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

    def get(self, run_id):
        self._prune()
        return copy.deepcopy(self.runs.get(run_id))
