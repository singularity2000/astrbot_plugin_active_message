from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

PLACEHOLDER_DESCRIPTIONS = {
    "persona_prompt": "当前会话实际生效的人格提示词全文（不是完整 Agent 系统提示）",
    "persona_name": "当前会话生效的人格名称",
    "conversation_history": "按上下文配置选择的当前 AstrBot 分支 JSON 历史",
    "current_message": "本次原始消息的可读内容",
    "recent_messages": "按上下文配置选取的原生近期群消息；runtime 降级时为不完整摘要",
    "now": "当前时间",
    "current_time": "当前时间（now 的兼容别名）",
    "time": "本次原消息时间；定时任务为当前时间",
    "date": "当前日期",
    "weekday": "星期",
    "platform": "平台适配器类型",
    "platform_id": "平台适配器实例 ID",
    "message_type": "消息类型",
    "chat_type": "群聊或私聊",
    "session_id": "会话编号",
    "sid": "完整会话 SID",
    "group_id": "群号（私聊为不适用）",
    "sender_id": "真实发言者 ID（定时任务为不适用）",
    "sender_name": "真实发言者昵称（定时任务为不适用）",
    "user_id": "sender_id 的兼容别名",
    "username": "sender_name 的兼容别名",
    "user_context": "由上述可得信息组成的用户/会话概况",
    "group_message_count": "活跃窗口内真人消息条数",
    "silence_seconds": "距最近真人消息的秒数",
    "activity_score": "群活跃原始分",
    "energy_score": "机器人精力原始分",
    "model_score": "模型判断原始分（仅判断后可用）",
    "score": "加权后的最终分（仅判断后可用）",
    "threshold": "本会话阈值",
    "decision_reason": "判断理由（Jev 通常未提供）",
    "activity_level": "按活跃分得到的低/中/高档位",
    "mood": "睡眠、正常或活跃",
    "trigger_type": "智能插话或主动聊天",
    "user_last_message_time": "当前会话上次观测到的真人发言时间",
    "user_last_message_time_ago": "该时间距今多久",
    "ai_last_sent_time": "当前会话上次确认机器人发送的时间",
    "unreplied_count": "本插件连续主动发言后未观测到真人回复的次数",
}
TOKEN = re.compile(r"\{([a-z][a-z0-9_]*)\}")
POST_DECISION = {"model_score", "score", "decision_reason"}


class TemplateError(ValueError):
    pass


def validate_template(template: str, *, decision: bool = False) -> None:
    tokens = set(TOKEN.findall(template))
    unknown = tokens - PLACEHOLDER_DESCRIPTIONS.keys()
    if unknown:
        raise TemplateError("unknown placeholders: " + ", ".join(sorted(unknown)))
    if decision and tokens & POST_DECISION:
        raise TemplateError(
            "placeholders available only after judging: "
            + ", ".join(sorted(tokens & POST_DECISION))
        )


def render_template(template: str, values: dict[str, Any]) -> str:
    """只替换允许的变量名；JSON 花括号不必转义，不执行表达式。"""

    validate_template(template)
    return TOKEN.sub(lambda match: str(values.get(match.group(1), "未知")), template)


def format_ago(seconds: float | None) -> str:
    if seconds is None:
        return "未知"
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds} 秒前"
    if seconds < 3600:
        return f"{seconds // 60} 分钟前"
    if seconds < 86400:
        return f"{seconds // 3600} 小时前"
    return f"{seconds // 86400} 天前"


def make_values(
    *,
    now: datetime,
    sid: str,
    platform: str,
    group_id: str = "",
    sender_id: str = "",
    sender_name: str = "",
    current_message: str = "",
    message_time: float | None = None,
    persona_prompt: str = "",
    persona_name: str = "",
    conversation_history: str = "[]",
    recent_messages: str = "",
    message_count: int = 0,
    silence_seconds: float | None = None,
    activity_score: float = 0.0,
    energy_score: float = 1.0,
    threshold: float = 0.75,
    mood: str = "正常",
    trigger_type: str = "智能插话",
    last_human_at: float | None = None,
    last_bot_at: float | None = None,
    unreplied_count: int = 0,
) -> dict[str, Any]:
    platform_id, message_type, session_id = sid.split(":", 2)
    timestamp_format = "%Y-%m-%d %H:%M:%S %Z"
    current = now.strftime(timestamp_format)
    def format_timestamp(ts: float | None) -> str:
        return datetime.fromtimestamp(ts, now.tzinfo).strftime(timestamp_format) if ts else "未知"
    sender_id = sender_id or "不适用"
    sender_name = sender_name or "不适用"
    values: dict[str, Any] = {
        "persona_prompt": persona_prompt,
        "persona_name": persona_name,
        "conversation_history": conversation_history,
        "current_message": current_message,
        "recent_messages": recent_messages,
        "now": current,
        "current_time": current,
        "time": format_timestamp(message_time) if message_time else current,
        "date": now.strftime("%Y-%m-%d"),
        "weekday": ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")[now.weekday()],
        "platform": platform,
        "platform_id": platform_id,
        "message_type": message_type,
        "chat_type": "群聊" if message_type == "GroupMessage" else "私聊",
        "session_id": session_id,
        "sid": sid,
        "group_id": group_id or "不适用",
        "sender_id": sender_id,
        "sender_name": sender_name,
        "user_id": sender_id,
        "username": sender_name,
        "group_message_count": message_count,
        "silence_seconds": round(silence_seconds, 1) if silence_seconds is not None else "未知",
        "activity_score": round(activity_score, 4),
        "energy_score": round(energy_score, 4),
        "threshold": threshold,
        "activity_level": "高" if activity_score >= 0.7 else "中" if activity_score >= 0.3 else "低",
        "mood": mood,
        "trigger_type": trigger_type,
        "user_last_message_time": format_timestamp(last_human_at),
        "user_last_message_time_ago": format_ago(now.timestamp() - last_human_at if last_human_at else None),
        "ai_last_sent_time": format_timestamp(last_bot_at),
        "unreplied_count": unreplied_count,
    }
    values["user_context"] = json.dumps(
        {k: values[k] for k in ("sid", "chat_type", "username", "user_id", "current_time", "user_last_message_time", "ai_last_sent_time")},
        ensure_ascii=False,
    )
    return values


# Only code-produced, bounded control values may be interpolated in system text.
CONTROL_FIELDS = {"now", "current_time", "time", "date", "weekday", "message_type", "chat_type",
                  "group_message_count", "silence_seconds", "activity_score", "energy_score",
                  "model_score", "score", "threshold", "activity_level", "mood", "trigger_type",
                  "user_last_message_time", "user_last_message_time_ago", "ai_last_sent_time", "unreplied_count"}


def render_system_template(template: str, values: dict[str, Any]) -> tuple[str, dict]:
    """Keep source text and model-generated reasons at user/data priority."""
    validate_template(template)
    references = {}
    def replace(match):
        key = match.group(1)
        if key in CONTROL_FIELDS:
            return str(values.get(key, "未知"))
        references[key] = values.get(key, "未知")
        return "[用户层参考资料字段：" + key + "]"
    return TOKEN.sub(replace, template), references
