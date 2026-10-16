from __future__ import annotations

from .i18n import catalog

import json
import re
from datetime import datetime
from typing import Any

PLACEHOLDER_DESCRIPTIONS = {key: row["description"] for key, row in catalog()["placeholders"].items()}
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
    threshold: float = 0.7,
    routine_state: str = "正常",
    trigger_type: str = "智能插话",
    last_human_at: float | None = None,
    last_bot_at: float | None = None,
    unreplied_count: int = 0,
    proactive_remaining: int = 0,
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
        "image_descriptions": "[]",
        "recent_messages": recent_messages,
        "now": current,
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
        "group_message_count": message_count,
        "silence_seconds": round(silence_seconds, 1) if silence_seconds is not None else "未知",
        "activity_score": round(activity_score, 4),
        "energy_score": round(energy_score, 4),
        "threshold": threshold,
        "activity_level": "高" if activity_score >= 0.7 else "中" if activity_score >= 0.3 else "低",
        "routine_state": routine_state,
        "timezone": str(now.tzinfo),
        "ai_last_sent_time_ago": format_ago(now.timestamp() - last_bot_at if last_bot_at else None),
        "proactive_remaining": max(0, proactive_remaining),
        "trigger_type": trigger_type,
        "user_last_message_time": format_timestamp(last_human_at),
        "user_last_message_time_ago": format_ago(now.timestamp() - last_human_at if last_human_at else None),
        "ai_last_sent_time": format_timestamp(last_bot_at),
        "unreplied_count": unreplied_count,
    }
    values["user_context"] = json.dumps(
        {k: values[k] for k in ("sid", "chat_type", "sender_name", "sender_id", "now", "user_last_message_time", "ai_last_sent_time")},
        ensure_ascii=False,
    )
    return values


# Only code-produced, bounded control values may be interpolated in system text.
CONTROL_FIELDS = {"now", "time", "date", "weekday", "message_type", "chat_type",
                  "group_message_count", "silence_seconds", "activity_score", "energy_score",
                  "model_score", "score", "threshold", "activity_level", "routine_state", "trigger_type",
                  "timezone", "ai_last_sent_time_ago", "proactive_remaining",
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


PLACEHOLDER_EXAMPLES = {key: row["example"] for key, row in catalog()["placeholders"].items()}


def placeholder_catalog():
    """Shared allow-list for validation, native hints and the Pages reference panel."""
    common = ["now", "date", "weekday", "timezone", "routine_state", "persona_name", "current_message",
              "decision_reason", "schedule_current", "schedule_upcoming", "user_last_message_time_ago",
              "ai_last_sent_time_ago", "unreplied_count", "proactive_remaining", "activity_score", "energy_score",
              "model_score", "score", "threshold", "trigger_type", "chat_type", "sender_name", "sender_id"]
    order = dict.fromkeys(common + list(PLACEHOLDER_DESCRIPTIONS))
    message_only = {"sender_id", "sender_name", "current_message", "time"}
    return [{"name": key, "token": "{" + key + "}", "description": PLACEHOLDER_DESCRIPTIONS[key],
             "example": PLACEHOLDER_EXAMPLES.get(key, "由当前会话实时填入"),
             "phases": ["activation"] if key in POST_DECISION else ["decision", "activation"] if key in message_only else ["proactive"] if key == "proactive_remaining" else ["decision", "activation", "proactive"]}
            for key in order]
