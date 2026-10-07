from __future__ import annotations

import json
from typing import Any


async def current_conversation(context: Any, sid: str) -> Any:
    manager = context.conversation_manager
    cid = await manager.get_curr_conversation_id(sid)
    if not cid:
        return None
    return await manager.get_conversation(sid, cid)


async def resolve_persona(
    context: Any, sid: str, conversation: Any, platform: str
) -> tuple[str, str]:
    """只读取当前 SID 的人格；明确禁用时不回退到默认人格。"""

    manager = getattr(context, "persona_manager", None)
    if manager is None or conversation is None:
        return "", ""
    config = context.get_config(umo=sid)
    resolver = getattr(manager, "resolve_selected_persona", None)
    if callable(resolver):
        _, persona, _, _ = await resolver(
            umo=sid,
            conversation_persona_id=getattr(conversation, "persona_id", None),
            platform_name=platform,
            provider_settings=config.get("provider_settings", {}),
        )
    else:
        # Older frameworks may lack the native resolver. Do not guess a persona
        # and pass a wrong identity to the judgment model.
        raise RuntimeError("PERSONA_API_MISSING")
    if not persona:
        return "", ""
    if isinstance(persona, dict):
        return str(persona.get("name", "")), str(persona.get("prompt", ""))
    return str(getattr(persona, "persona_id", "")), str(getattr(persona, "system_prompt", ""))


def history_json(conversation: Any) -> str:
    if conversation is None:
        return "[]"
    raw = getattr(conversation, "history", "[]") or "[]"
    if isinstance(raw, str):
        parsed = json.loads(raw)
    else:
        parsed = raw
    if not isinstance(parsed, list):
        raise ValueError("conversation history must be a list")
    return json.dumps(parsed, ensure_ascii=False)


def platform_for_sid(context: Any, sid: str) -> Any:
    platform_id = sid.split(":", 1)[0]
    manager = getattr(context, "platform_manager", None)
    for platform in getattr(manager, "platform_insts", []):
        if str(platform.meta().id) == platform_id:
            return platform
    return None


def session_allows_plugin(context: Any, sid: str, plugin_name: str) -> bool:
    config = context.get_config(umo=sid)
    selected = config.get("plugin_set", ["*"])
    if selected != ["*"] and plugin_name not in selected:
        return False
    if not config.get("provider_settings", {}).get("enable", True):
        return False
    return True


def tool_response_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    parts = getattr(result, "content", None)
    if isinstance(parts, list):
        return "\n".join(str(getattr(part, "text", "")) for part in parts)
    return ""
