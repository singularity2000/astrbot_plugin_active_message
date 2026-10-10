"""Text-only projections for judging and diagnostics; never mutates native history."""
from __future__ import annotations

import json
import math
import re
from typing import Any

MEDIA_LABELS = {"image": "[Image]", "image_url": "[Image]", "input_image": "[Image]",
                "audio": "[Audio]", "input_audio": "[Audio]", "audio_url": "[Audio]",
                "video": "[Video]", "video_url": "[Video]", "file": "[File]", "input_file": "[File]"}
DATA_URI = re.compile(r"data:([a-zA-Z0-9.+-]+)/(?:[a-zA-Z0-9.+-]+)(?:;[^,\s]*)?;base64,[A-Za-z0-9+/=_-]+")
BASE64_URI = re.compile(r"base64://[A-Za-z0-9+/=_-]+")
BARE_BASE64 = re.compile(r"[A-Za-z0-9+/]{128,}={0,2}\Z")
CUT = "…[文字已缩减]"
MAX_DEPTH = 24  # Defensive recursion bound, not a model context limit.


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def estimate_tokens(text: str) -> int:
    """Conservative character heuristic, not a provider's exact tokenizer."""
    ascii_count = sum(ord(c) < 128 for c in text)
    return math.ceil(ascii_count / 3 + (len(text) - ascii_count) * 2)


def text_only(text: str, limit: int | None = None) -> str:
    text = DATA_URI.sub(lambda m: MEDIA_LABELS.get(m.group(1).lower(), "[File]"), text)
    text = BASE64_URI.sub("[Media]", text)
    if BARE_BASE64.fullmatch(text):
        text = "[Media]"
    if limit is not None and len(text) > limit:
        text = text[:max(0, limit - len(CUT))] + CUT
    return text


def project(value: Any, limit: int | None = None, depth: int = 0) -> Any:
    if depth > MAX_DEPTH:
        return "[嵌套过深，已省略]"
    if isinstance(value, str):
        return text_only(value, limit)
    if isinstance(value, (list, tuple)):
        return [project(item, limit, depth + 1) for item in value]
    if isinstance(value, dict):
        kind = str(value.get("type", "")).lower()
        if kind in MEDIA_LABELS:
            caption = value.get("caption") or value.get("description")
            label = MEDIA_LABELS[kind]
            return label + (" " + text_only(caption, limit) if isinstance(caption, str) and caption else "")
        return {str(k): project(v, limit, depth + 1) for k, v in value.items()}
    return value


def project_record(value: Any, limit: int) -> Any:
    result = project(value, limit)
    encoded = dumps(result)
    if len(encoded) > limit:
        return {"content": text_only(encoded, limit), "shortened": True}
    return result


def over_budget(text: str, max_chars: int, max_tokens: int) -> bool:
    return len(text) > max_chars or estimate_tokens(text) > max_tokens


def drop_oldest(payload: dict) -> bool:
    """Drop the oldest record from the largest source, keeping each source ordered."""
    lists = [payload[key] for key in ("conversation_history", "recent_group_messages", "image_descriptions")
             if isinstance(payload.get(key), list) and payload[key]]
    if not lists:
        return False
    max(lists, key=lambda rows: sum(len(dumps(row)) for row in rows)).pop(0)
    return True


def fit_payload(payload: dict, max_chars: int, max_tokens: int) -> tuple[dict, int]:
    encoded = dumps(payload)
    chars = len(encoded)
    units = sum(1 if ord(c) < 128 else 6 for c in encoded)
    sources = {}
    for key in ("conversation_history", "recent_group_messages", "image_descriptions"):
        rows = payload.get(key)
        if isinstance(rows, list) and rows:
            costs = []
            for row in rows:
                text = dumps(row)
                costs.append((len(text), sum(1 if ord(c) < 128 else 6 for c in text)))
            sources[key] = {"rows": rows, "costs": costs, "offset": 0,
                            "chars": sum(cost[0] for cost in costs)}
    removed = 0
    while chars > max_chars or math.ceil(units / 3) > max_tokens:
        available = [source for source in sources.values() if source["offset"] < len(source["rows"])]
        if not available:
            break
        source = max(available, key=lambda item: item["chars"])
        row_chars, row_units = source["costs"][source["offset"]]
        comma = int(len(source["rows"]) - source["offset"] > 1)
        chars -= row_chars + comma
        units -= row_units + comma
        source["chars"] -= row_chars
        source["offset"] += 1
        removed += 1
    for key, source in sources.items():
        payload[key] = source["rows"][source["offset"]:]
    return payload, removed
