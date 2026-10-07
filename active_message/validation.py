"""Feature-scoped validation with field paths, never secret values."""
from __future__ import annotations
import math
from .prompts import validate_template
from .schedule import get_timezone, parse_time_ranges
from .decisions import DecisionError, validate_jev_endpoint


def validate_config(config, raw=None) -> dict[str, list[tuple[str, str]]]:
    errors = {"shared": [], "interjection": [], "proactive": []}
    if not config.enabled:
        return errors
    def check(section, path, callback, hint):
        try:
            callback()
        except (ValueError, KeyError, TypeError, RuntimeError, DecisionError):
            errors[section].append((path, hint))
    if config.interjection_enabled or config.proactive_enabled:
        if config.missing_group_history not in {"skip", "runtime"}:
            errors["shared"].append(("context.missing_group_history", "请选择 skip 或 runtime。"))
    if config.interjection_enabled:
        if config.debounce_max_seconds < config.debounce_seconds or config.debounce_max_seconds < 0:
            errors["interjection"].append(("interjection.debounce_max_seconds", "最长合并时间不能小于停顿等待时间。"))
        total_weight = sum(abs(weight) for weight in config.weights())
        if total_weight == 0 or not math.isfinite(total_weight):
            errors["interjection"].append(("interjection.weights", "至少一个权重必须不为零，绝对权重总和不能超出有限数值范围。"))
        for index, group in enumerate(config.groups):
            if group.interjection_enabled:
                check("interjection", f"session_groups[{index}].threshold_override", group.threshold,
                      "阈值须留空或填写 0～1 的有限数字。")
        for index, prompt in enumerate(config.activation_prompts):
            check("interjection", f"activation_prompts[{index}]", lambda p=prompt: validate_template(p),
                  "存在未知占位符，请对照 README 的占位符列表。")
        if config.model_weight:
            decision = config.decision
            if decision.mode not in {"llm", "jev"}:
                errors["interjection"].append(("interjection.decision.mode", "请选择 llm 或 jev。"))
            elif decision.mode == "llm" and not decision.provider_id:
                errors["interjection"].append(("interjection.decision.provider_id", "请选择 AstrBot 判断模型提供商。"))
            elif decision.mode == "jev":
                check("interjection", "interjection.decision.jev_endpoint", lambda: validate_jev_endpoint(decision.jev_endpoint),
                      "请填写兼容 TypeSafe 协议的完整 HTTPS 接口地址；HTTP 仅限本机回环地址。")
                if not decision.jev_api_key or any(c in decision.jev_api_key for c in "\r\n"):
                    errors["interjection"].append(("interjection.decision.jev_api_key", "请填写有效 API Key，不能含换行。"))
            for key in ("prompt", "jev_state_template"):
                check("interjection", "interjection.decision." + key,
                      lambda k=key: validate_template(getattr(decision, k), decision=True),
                      "存在未知占位符，或引用了判断完成后才有的分数、理由。")
    if config.proactive_enabled:
        check("proactive", "proactive_chat.timezone", lambda: get_timezone(config.timezone), "请输入有效 IANA 时区，例如 Asia/Shanghai。")
        for key in ("sleep_hours", "active_hours"):
            check("proactive", "proactive_chat." + key, lambda k=key: parse_time_ranges(getattr(config, k)),
                  "格式应为 HH:MM-HH:MM；多个时段使用英文逗号分隔。")
        if config.proactive_min_interval_minutes > config.proactive_max_interval_minutes:
            errors["proactive"].append(("proactive_chat.min_interval_minutes", "最短间隔不能大于最长间隔。"))
        for index, prompt in enumerate(config.proactive_prompts):
            check("proactive", f"proactive_chat.prompts[{index}]", lambda p=prompt: validate_template(p), "存在未知占位符，请对照 README。")
        check("proactive", "proactive_chat.task_prompt", lambda: validate_template(config.proactive_task_prompt), "存在未知占位符，请对照 README。")
    if isinstance(raw, dict):
        rules = []
        if config.interjection_enabled:
            rules += [("interjection", "interjection." + key, low, high, integer) for key, low, high, integer in [
                ("debounce_max_seconds", 0, None, False), ("decision_max_age_seconds", 1, None, False), ("threshold", 0, 1, False), ("debounce_seconds", 0, None, False),
                ("max_recent_messages", 10, None, True),
                ("activity.window_seconds", 1, None, True), ("activity.target_messages", 1, None, True),
                ("activity.freshness_seconds", 1, None, True), ("energy.window_seconds", 1, None, True),
                ("energy.target_messages", 1, None, True),
                ("weights.model", None, None, False), ("weights.activity", None, None, False), ("weights.energy", None, None, False)]]
            if config.model_weight:
                rules += [("interjection", "interjection.decision.timeout_seconds", 1, None, True),
                          ("interjection", "runtime.judgment_concurrency", 1, None, True)]
        if config.proactive_enabled:
            rules += [("proactive", "proactive_chat." + key, low, high, integer) for key, low, high, integer in [
                ("min_interval_minutes", 1, None, True), ("max_interval_minutes", 1, None, True),
                ("daily_limit", 1, None, True), ("active_interval_multiplier", .1, 1, False)]]
            rules += [("proactive", "runtime.proactive_concurrency", 1, None, True),
                      ("proactive", "runtime.proactive_timeout_seconds", 1, None, True)]
        if config.interjection_enabled or config.proactive_enabled:
            rules += [("shared", "context.history_messages", 0, None, True),
                      ("shared", "context.recent_messages", 0, None, True),
                      ("shared", "interjection.cooldown_seconds", 0, None, False)]
        for section, path, low, high, integer in rules:
            value = raw
            for key in path.split("."):
                if not isinstance(value, dict) or key not in value:
                    value = None
                    break
                value = value[key]
            if value is None:
                continue
            try:
                number = float(value)
                valid = (not isinstance(value, bool) and math.isfinite(number)
                         and (low is None or number >= low) and (high is None or number <= high)
                         and (not integer or number.is_integer()))
            except (TypeError, ValueError, OverflowError):
                valid = False
            if not valid:
                kind = "整数" if integer else "数字"
                bounds = f"；范围 {low if low is not None else '不限'}～{high if high is not None else '不限'}"
                errors[section].append((path, "请输入有效的有限" + kind + bounds + "；不会静默采用修正后的值。"))
    return errors
