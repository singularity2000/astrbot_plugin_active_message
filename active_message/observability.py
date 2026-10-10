from __future__ import annotations

import json
import traceback
import time
from typing import Any


MESSAGES = {
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
    "CONFIG_INVALID": "配置有误；仅暂停受影响功能，请按 field 字段位置和 explanation 说明修正。",
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
    "MESSAGE_SENT": "已确认一次发送成功；每日主动轮次按成功发言的任务计数。",
    "ACTIVATION_PROMPT_INJECTED": "激活指令已注入，外部文本在用户层作为参考资料传递。",
    "PROACTIVE_SCHEDULED": "已安排下次主动聊天时间；只有最早的待执行计划会设置闹钟。",
    "PROACTIVE_SKIPPED": "本次主动机会未满足作息、上限、冷却、会话或平台条件，已跳过。",
    "PROACTIVE_NO_SEND": "本轮 Agent 没有成功发送，不计入每日成功轮次。",
    "PROACTIVE_RUN_FAILED": "主动聊天执行失败或超时；已发送内容不会撤回，将重新安排下次机会。",
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
        stack = [
            {"file": frame.filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1], "line": frame.lineno, "function": frame.name}
            for frame in traceback.extract_tb(exc.__traceback__)
        ]
        self.log("error", code, exception=type(exc).__name__, stack=stack, **fields)
