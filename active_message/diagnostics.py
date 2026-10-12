"""结构化日志、异常摘要与有容量和时限的内存决策回放。"""
from __future__ import annotations

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

    def clear(self):
        self.runs.clear()
        self.sizes.clear()

    def watch(self, run_id, sid, kind, snapshot):
        self.live[run_id] = {"sid": sid, "kind": kind,
                             "created_at": self.runs.get(run_id, {}).get("created_at", time.time()),
                             "snapshot": snapshot}

    def _active_run(self, run_id):
        live = self.live.get(run_id)
        if live is None:
            return None
        return {"run_id": run_id, "sid": live["sid"], "kind": live["kind"],
                "created_at": live["created_at"], "status": "进行中", "steps": [],
                "raw_enabled": self.capture_raw, "history_omitted": True}

    def _summary(self, run):
        result = {k: v for k, v in run.items() if k != "steps"}
        live = self.live.get(run["run_id"])
        if live is not None:
            result["progress"] = live["snapshot"]()
        return result

    def _prune(self):
        now = time.time()
        for key in list(self.runs):
            if key not in self.live and now - self.runs[key].get("finished_at", self.runs[key]["created_at"]) > self.ttl:
                self.runs.pop(key, None); self.sizes.pop(key, None)
        while sum(self.sizes.values()) > self.budget:
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

    def add(self, run_id, label, data=None, *, raw=False, terminal=False):
        self._prune()
        run = self.runs.get(run_id)
        if run is None and terminal:
            run = self._active_run(run_id)
            if run is not None:
                self.runs[run_id] = run
                self.sizes[run_id] = 512
        if not run: return
        if len(run["steps"]) >= (100 if terminal else 97):
            run["steps_omitted"] = run.get("steps_omitted", 0) + 1
            if not terminal:
                return
            # Preserve the final failure/summary even after a long tool loop.
            removed = run["steps"].pop()
            self.sizes[run_id] -= len(json.dumps(removed, ensure_ascii=False).encode("utf-8")) + 128
        step = {"label":label, "at":time.time(), "raw":raw}
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
        if run_id not in self.runs:
            active = self._active_run(run_id)
            if active is not None:
                self.runs[run_id] = active
                self.sizes[run_id] = 512
        self.live.pop(run_id, None)
        if run_id in self.runs:
            self.runs[run_id]["status"] = status
            self.runs[run_id]["finished_at"] = time.time()
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


MESSAGES = {
    "AGENDA_RESTORE_FAILED": "日程数据加载或保存恢复失败；已保护原文件并暂停插件，请检查 agenda.json 和配置后重载。",
    "AGENDA_SAVE_FAILED": "日程与配置保存未完成；已保留恢复记录并暂停插件，请重载恢复，不要回写旧草稿。",
    "AGENDA_TIMEZONE_INVALID": "日程时区无效，预览回退到系统时区；请修正配置。",
    "AGENDA_CONTEXT_UNSUPPORTED": "框架缺少临时消息内容接口；未注入日程，避免污染历史。请升级 AstrBot。",
    "EMPTY_SESSION_GROUP": "空会话组没有目标；列表非空时仍为白名单模式。",
    "IMAGE_CONTEXT_UNAVAILABLE": "当前框架无法只读提供待注入的群图片转述；保留原历史与媒体标签，不重复识图。",
    "JUDGMENT_INPUT": "判断输入已按预算准备；token 为估算值，不等于服务实际计费。",
    "MODEL_RETRY": "遇到临时故障，按本轮超时与重试设置等待重试。",
    "INPUT_TOO_LARGE": "历史已缩减，但固定提示词或当前输入仍超预算；请缩短提示词或合理调整判断预算。",
    "PAGE_PREFERENCES_FAILED": "界面偏好存储失败，不影响运行配置。",
    "CONFIG_APPLIED": "配置已保存并生效，待执行计划已重新安排。",
    "DIAGNOSTIC_CAPTURE_FAILED": "本次诊断快照未能保存；不影响发言流程，不会用摘要冒充全文。",
    "PAGE_READ_FAILED": "运行检查台读取失败，请检查页面接口与 Provider 状态。",
    "CONFIG_SAVE_FAILED": "配置保存失败，未切换运行配置；请刷新页面并检查日志。",
    "SCHEDULE_REPAIRED": "保存的计划时间无效或缺少时区，已为该会话重新安排，不影响其他会话。",
    "ORIGINAL_ACTIVE_REPLY_ENABLED": "该会话仍开启 AstrBot 原版主动回复，本插件已跳过智能插话。请先关闭原版主动回复。",
    "CONFIG_INVALID": "配置有误；对应功能已暂停，SID 范围或公共配置错误可能暂停整个插件。请按 field 位置和 explanation 说明修正。",
    "GROUP_HISTORY_DISABLED": "未启用或无法访问原生群消息历史，已跳过本轮。请开启 AstrBot 群消息历史保存，或明确选择 runtime 不完整摘要模式。",
    "GROUP_HISTORY_READ_FAILED": "读取原生群消息历史失败，已跳过本轮；请检查主框架消息历史服务。",
    "CONTEXT_HISTORY_INVALID": "当前分支历史不是有效的消息列表，已跳过本轮；请检查主框架会话数据。",
    "CONTEXT_RUNTIME_FALLBACK": "正在使用不完整的运行时消息摘要。它受统计窗口、缓存条数和重启影响，不等于完整群历史。",
    "CONTEXT_PREPARED": "上下文准备完成；selected 是实际条数，available 是当前原生保留条数，source 是来源。正文不写日志。",
    "PROVIDER_MISSING": "判断模型未配置或不可用，请检查所选 AstrBot Provider。",
    "MODEL_TIMEOUT": "判断模型请求超时，本轮不插话。",
    "MODEL_INVALID": "判断模型返回格式或分数无效，本轮不插话。",
    "MODEL_ERROR": "判断模型调用失败，本轮不插话；请检查 Provider 服务。",
    "JEV_CONFIG": "Jev 连接配置无效，请检查兼容接口地址和 API Key。",
    "JEV_HTTP": "Jev 服务未成功接受请求，本轮不插话；请检查额度、凭据和服务状态。",
    "DECISION_COMPLETED": "判断完成；score 包含原始分、正负权重、贡献与最终分，triggered 表示是否严格超过阈值。",
    "DECISION_STALE": "判断期间来了新消息或进入冷却，旧结果已丢弃。",
    "COOLDOWN": "机器人刚刚发言，仍在共享冷却期，暂不插话。",
    "AGENT_ACTIVE": "本会话 Agent 正在运行，暂不重复触发。",
    "NO_CONVERSATION": "本会话还没有原生对话分支，请先与机器人正常对话或使用 /new。",
    "AGENT_REQUESTED": "插话判断通过，已交给原生 Agent。",
    "AGENT_STARTED": "原生 Agent 已开始主动聊天。",
    "AGENT_DONE": "原生 Agent 已结束；是否发送以 MESSAGE_SENT 为准。",
    "MESSAGE_SENT": "已确认一次发送成功；主动任务本轮消耗一次额度，分段发送不重复计数。",
    "ACTIVATION_PROMPT_INJECTED": "激活指令已注入，外部文本在用户层作为参考资料传递。",
    "PROACTIVE_SCHEDULED": "已安排下次主动聊天时间；只有最早的待执行计划会设置闹钟。",
    "PROACTIVE_SKIPPED": "本次主动机会未满足作息、上限、冷却、会话或平台条件，已跳过。",
    "PROACTIVE_SEND_SKIPPED": "发送前检查决定放弃本次发送；这是业务限制，不代表模型调用失败。",
    "PROACTIVE_NO_SEND": "本轮尚未确认发送；是否消耗每日额度以整轮最终结果为准。",
    "PROACTIVE_QUOTA_USED": "本轮正常完成但未发送，已消耗一次主动尝试额度；发言冷却和无人回复数不变。",
    "PROACTIVE_RUN_FAILED": "主动聊天执行失败或超时；已发送内容不会撤回，将重新安排下次机会。",
    "PROACTIVE_TIMEOUT": "主动聊天达到整轮时间上限；请查看停留阶段、各阶段耗时和最近一次模型／工具结果。",
    "PROACTIVE_PROGRESS": "主动聊天执行阶段已更新。",
    "PROACTIVE_LLM_STARTED": "开始调用原生聊天模型；此耗时包含 Provider 内部重试。",
    "PROACTIVE_LLM_FINISHED": "本次原生模型调用已返回。",
    "PROACTIVE_LLM_ATTEMPT_ERROR": "本次模型尝试未成功；本轮结果待主框架确认，框架仍可能重试或切换备用模型。",
    "PROACTIVE_TOOL_FAILED": "原生工具执行失败；框架可能将错误交回模型继续处理。",
    "PROACTIVE_NATIVE_ERROR": "主框架已判定本轮 Agent 最终失败；请结合模型尝试与工具记录定位。",
    "PROACTIVE_COMPLETED": "主动任务结束；发送结果与整轮执行结果分别记录。",
    "PROACTIVE_CLEANUP_PENDING": "工具未响应取消，清理等待已结束，插件暂停主动功能；请处理该工具或重启 AstrBot，避免重复执行。",
    "PROACTIVE_RUNNER_UNSUPPORTED": "主动聊天仅支持原生 local Runner，本会话已跳过。",
    "PLATFORM_PROACTIVE_UNAVAILABLE": "目标平台未连接或不支持主动发送，已跳过。",
    "SESSION_LLM_DISABLED": "本会话已关闭 LLM，已跳过主动聊天。",
    "BARE_SID_AMBIGUOUS": "纯数字 SID 无法确定平台，请填写完整 SID。",
    "SESSION_CAPACITY": "已达到 500 个会话的安全容量，请缩小会话白名单。",
    "STATE_RESTORE_FAILED": "运行状态恢复失败；为避免覆盖原数据，插件暂停。",
    "STATE_SAVE_FAILED": "运行状态保存失败；重启后计数和计划可能无法恢复。",
    "SCHEDULER_FAILED": "调度异常，60 秒后重试；正常运行没有每分钟轮询。",
    "PLUGIN_INITIALIZED": "插件初始化完成；请同时查看分功能配置状态。",
    "PLUGIN_TERMINATED": "插件已停止，闹钟与任务已取消。",
    "INTERJECTION_FAILED": "本轮智能插话执行失败，请检查异常类型和代码位置。",
}
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
        record = {"code": code, "message": MESSAGES.get(code, code), **fields}
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
