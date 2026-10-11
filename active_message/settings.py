"""默认值、会话组继承、生效配置解析与分功能校验。"""
from __future__ import annotations

import copy
import json
import re
import math
from pathlib import Path
from dataclasses import dataclass
from .config import PluginConfig
from .sessions import SessionScopes
from .agenda import Agenda, config_only, event_schema, normalize_agenda_links, populate_agenda_choices
from .prompts import validate_template
from .schedule import get_timezone, parse_time_ranges
from .decisions import DecisionError, validate_jev_endpoint


SCHEMA_PATH = Path(__file__).resolve().parents[1] / "_conf_schema.json"


def schema():
    """Pages/runtime schema; event records are not native settings."""
    result = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    result["agenda"]["items"]["events"] = event_schema()
    return result


def shape_errors(raw, fields, prefix=""):
    errors = []
    if not isinstance(raw, dict):
        return [(prefix or "config", "配置必须是对象。")]
    for key, value in raw.items():
        if key not in fields: continue
        spec = fields[key]; path = prefix + key; kind = spec["type"]
        if kind == "object":
            errors.extend(shape_errors(value, spec["items"], path + "."))
        elif kind == "template_list":
            if not isinstance(value, list): errors.append((path, "此项必须是列表。"))
            else:
                for index, item in enumerate(value):
                    key = item.get("__template_key", next(iter(spec["templates"]))) if isinstance(item, dict) else ""
                    if key not in spec["templates"]:
                        errors.append((f"{path}[{index}]", "未知的列表模板。"))
                    else:
                        errors.extend(shape_errors(item, spec["templates"][key]["items"], f"{path}[{index}]."))
        elif kind == "list":
            if not isinstance(value, list) or any(not isinstance(v, str) for v in value): errors.append((path, "此项需要文本列表。"))
        elif kind == "bool":
            if not isinstance(value, bool): errors.append((path, "开关必须为 true 或 false。"))
        elif isinstance(value, (dict, list, bool)) or value is None:
            errors.append((path, "此项需要文本或数字，不能是对象、列表或空值。"))
    return errors


def fill_defaults(raw, fields):
    raw = raw if isinstance(raw, dict) else {}
    output = {}
    for key, spec in fields.items():
        if spec["type"] == "object":
            output[key] = fill_defaults(raw.get(key, {}), spec["items"])
        elif spec["type"] == "template_list":
            items = raw.get(key, [])
            template = next(iter(spec["templates"]))
            output[key] = [fill_defaults(item, spec["templates"][template]["items"]) | {"__template_key": template}
                           for item in items if isinstance(item, dict)] if isinstance(items, list) else []
        else:
            output[key] = copy.deepcopy(raw.get(key, spec.get("default")))
    return output


def feature_enabled(mode, global_enabled):
    """Group choices override only the matching global feature switch, not the master."""
    return True if mode == "开启" else False if mode == "关闭" else bool(global_enabled)


def blank(value):
    return value is None or value == "" or value == [] or (isinstance(value, str) and not value.strip()) or (isinstance(value, list) and all(isinstance(v, str) and not v.strip() for v in value))


def overlay(base, patch, fields):
    """只覆盖配置表中允许的项；留空继承，0 是实际值。"""
    for key, spec in fields.items():
        value = patch.get(key) if isinstance(patch, dict) else None
        if blank(value):
            continue
        if spec["type"] == "object":
            overlay(base.setdefault(key, {}), value, spec["items"])
        else:
            if spec["type"] in {"int", "float"}:
                try:
                    number = float(value)
                    value = int(number) if spec["type"] == "int" and number.is_integer() else number
                except (ValueError, TypeError, OverflowError):
                    pass  # validate_config will report the exact field, without its value.
            if key in {"sleep_hours", "active_hours"} and value == "无":
                value = ""
            base[key] = copy.deepcopy(value)


@dataclass
class EffectiveSettings:
    raw: dict
    config: PluginConfig
    errors: dict
    agenda: Agenda

    def valid(self, feature):
        return (not self.errors.get("shared") and not self.errors.get(feature)
                and not (self.agenda.enabled and self.errors.get("agenda")))


class Settings:
    def __init__(self, raw):
        # PageAPI binds both revisions when validating its draft. Main passes
        # them to AgendaStore.save; never infer fresh revisions at save time.
        self.agenda_revision: str | None = None
        self.config_revision: str | None = None
        self.schema = schema()
        self.shape_errors = shape_errors(raw, self.schema)
        self.raw = fill_defaults(raw, self.schema)
        # Preserve extension fields in runtime data across normal edits. Schema
        # defaults/validation still apply to every declared event field.
        source_agenda = raw.get("agenda", {}) if isinstance(raw, dict) else {}
        source_events = source_agenda.get("events", []) if isinstance(source_agenda, dict) else []
        if isinstance(source_events, list):
            originals = [row for row in source_events if isinstance(row, dict)]
            self.raw["agenda"]["events"] = [copy.deepcopy(before) | after
                                           for before, after in zip(originals, self.raw["agenda"]["events"])]
        self.agenda_links_changed = normalize_agenda_links(self.raw)
        if not self.shape_errors:
            populate_agenda_choices(self.schema, self.raw)
        self.config = PluginConfig.from_raw(self.raw)
        self.agenda_catalog_errors = list(Agenda(self.raw["agenda"], max_events=1000).errors)
        target_counts = {}
        for event in self.raw["agenda"]["events"]:
            for sid in event.get("target_sids", []) if isinstance(event.get("target_sids", []), list) else []:
                if isinstance(sid, str):
                    target_counts[sid] = target_counts.get(sid, 0) + 1
        if any(count > 100 for count in target_counts.values()):
            self.agenda_catalog_errors.append(("agenda.events.target_sids", "每个指定会话最多 100 条专属日程。"))
        group_ids = [g.get("agenda_id", "") for g in self.raw["session_groups"] if isinstance(g.get("agenda_id"), str) and g["agenda_id"]]
        if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", ident) for ident in group_ids):
            self.shape_errors.append(("session_groups.agenda_id", "日程分组标识使用 1～80 位字母、数字、下划线或短横线。"))
        if len(set(group_ids)) != len(group_ids):
            self.shape_errors.append(("session_groups.agenda_id", "日程分组标识重复，无法安全区分会话组。"))
        for i, event in enumerate(self.raw["agenda"]["events"]):
            if event.get("group_id") and event["group_id"] not in group_ids:
                self.agenda_catalog_errors.append((f"agenda.events[{i}].group_id", "原会话组不存在，请重新选择日程适用范围；不会自动变成全局日程。"))
        self.scope_error = ""
        try:
            self.scopes = SessionScopes(self.config)
        except ValueError:
            self.scope_error = "SID 格式错误或重复，请检查会话组。"
            self.scopes = SessionScopes(PluginConfig.from_raw({**self.raw, "session_groups": []}))
        global_raw = copy.deepcopy(self.raw)
        global_raw["session_groups"] = []
        global_raw["agenda"]["events"] = [e for e in global_raw["agenda"]["events"] if not e.get("group_id") and not e.get("target_sids")]
        self.global_entry = self._entry(global_raw)
        self.warnings = []
        for index, group in enumerate(self.config.groups):
            if not group.sids:
                self.warnings.append({"code": "EMPTY_SESSION_GROUP", "group_index": index, "message": f"会话组 {index + 1} 没有 SID，不会作用于任何会话；列表非空时仍为白名单模式。"})
        self.groups = []
        self._by_identity = {}
        self._sid_entries = {}
        for index, group in enumerate(self.config.groups):
            item = self.raw["session_groups"][index]
            merged = copy.deepcopy(global_raw)
            inter = item.get("interjection_overrides", {})
            pro = item.get("proactive_overrides", {})
            overlay(merged["interjection"]["decision"], item.get("decision_overrides", {}),
                    self.schema["interjection"]["items"]["decision"]["items"])
            overlay(merged["interjection"], inter, self.schema["interjection"]["items"])
            for section in ("weights", "activity", "energy"):
                overlay(merged["interjection"][section], item.get("interjection_" + section, {}),
                        self.schema["interjection"]["items"][section]["items"])
            overlay(merged["proactive_chat"], pro, self.schema["proactive_chat"]["items"])
            overlay(merged["context"], item.get("context_overrides", {}), self.schema["context"]["items"])
            if not blank(item.get("threshold_override")):
                overlay(merged["interjection"], {"threshold": item["threshold_override"]}, self.schema["interjection"]["items"])
            if not blank(inter.get("activation_prompts")):
                merged["activation_prompts"] = copy.deepcopy(inter["activation_prompts"])
            if not blank(item.get("cooldown_override")):
                overlay(merged["interjection"], {"cooldown_seconds":item["cooldown_override"]}, self.schema["interjection"]["items"])
            mode = item.get("decision_mode", "跟随全局")
            if mode != "跟随全局":
                merged["interjection"]["decision"]["mode"] = mode
            inter_on = feature_enabled(group.interjection_mode, self.config.interjection_enabled)
            pro_on = feature_enabled(group.proactive_mode, self.config.proactive_enabled)
            # The plugin master switch is global and cannot be overridden by a group.
            merged["enabled"] = self.config.enabled
            merged["interjection"]["enabled"] = inter_on
            merged["proactive_chat"]["enabled"] = pro_on
            exclusions = item.get("agenda_exclusions", [])
            excluded = {v for v in exclusions if isinstance(v, str)} if isinstance(exclusions, list) else set()
            global_events = [e for e in global_raw["agenda"]["events"] if not isinstance(e["id"], str) or e["id"] not in excluded]
            local_events = [e for e in self.raw["agenda"]["events"] if item.get("agenda_id") and e.get("group_id") == item["agenda_id"]]
            merged["agenda"]["events"] = copy.deepcopy(global_events + local_events)
            merged["agenda"]["enabled"] = feature_enabled(item.get("agenda_mode"), global_raw["agenda"]["enabled"])
            for key in ("preview_days", "max_items"):
                value = item.get("agenda_" + key, "跟随全局")
                if value != "跟随全局":
                    merged["agenda"][key] = value
            entry = self._entry(merged, {e["id"]: "本组" for e in local_events if isinstance(e["id"], str)})
            if item.get("agenda_mode") not in {"跟随全局", "开启", "关闭"}:
                entry.errors["agenda"].append(("agenda_mode", "请选择跟随全局、开启或关闭。"))
            if len(local_events) > 100:
                entry.errors["agenda"].append(("agenda.events", "每组最多 100 条新增日程。"))
            global_ids = {e["id"] for e in global_raw["agenda"]["events"] if isinstance(e["id"], str)}
            if any(isinstance(e["id"], str) and e["id"] in global_ids for e in local_events):
                entry.errors["agenda"].append(("agenda.events", "本组日程标识不能与全局重复，即使该全局日程已排除。"))
            self.groups.append(entry)
            for key in ("interjection_mode", "proactive_mode"):
                if item.get(key) not in {"跟随全局", "开启", "关闭"}:
                    entry.errors["shared"].append((key, "请选择跟随全局、开启或关闭。"))
            self._by_identity[id(group)] = entry

    @property
    def config_raw(self):
        """Settings-only snapshot. Persist via AgendaStore.save, not alone."""
        return config_only(self.raw)

    def any_enabled(self, feature=None):
        if not self.config.enabled:
            return False
        entries = list(self.groups) if self.config.groups else [self.global_entry]
        if feature in (None, "agenda") and self.raw["agenda"].get("outside_scope"):
            entries.append(self.global_entry)
        for entry in entries:
            cfg = entry.config
            if feature in (None, "agenda") and entry.agenda.enabled and entry.valid("agenda"):
                return True
            if cfg.enabled and any(
                (name == feature or feature is None) and getattr(cfg, name + "_enabled") and entry.valid(name)
                for name in ("interjection", "proactive")
            ):
                return True
        return False

    def _entry(self, raw, origins=None):
        config = PluginConfig.from_raw(raw)
        errors = validate_config(config, raw)
        agenda = Agenda(raw.get("agenda", {}), origins=origins, timezone_name=config.timezone, max_events=1000)
        errors["agenda"] = agenda.errors
        if origins is None and len(raw.get("agenda", {}).get("events", [])) > 100:
            errors["agenda"].append(("agenda.events", "全局最多 100 条日程。"))
        errors["shared"].extend(self.shape_errors)
        if self.scope_error:
            errors["shared"].append(("session_groups.sids", self.scope_error))
        # Resource/diagnostic limits remain global and bounded, even with the plugin off.
        for key, low, high in (("max_runs", 1, 500), ("retention_minutes", 1, 1440), ("max_memory_mb", 1, 128), ("max_step_chars", 256, 1048576)):
            value = self.raw.get("diagnostics", {}).get(key)
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                errors["shared"].append(("diagnostics." + key, f"请输入 {low}～{high} 的整数。"))
        return EffectiveSettings(raw, config, errors, agenda)

    def for_group(self, group):
        return self._by_identity.get(id(group), self.global_entry)

    def for_sid(self, sid):
        entry = self.for_group(self.scopes.match(sid)[1])
        key = (sid, id(entry))
        if key in self._sid_entries:
            return self._sid_entries[key]
        targeted = [e for e in self.raw["agenda"]["events"] if sid in e.get("target_sids", [])]
        if not targeted:
            return entry
        raw = copy.deepcopy(entry.raw)
        raw["agenda"]["events"].extend(copy.deepcopy(targeted))
        origins = {e["id"]: "本组" for e in entry.raw["agenda"]["events"] if e.get("group_id")}
        origins.update({e["id"]: "指定会话" for e in targeted})
        result = self._entry(raw, origins)
        self._sid_entries[key] = result
        return result

    def all_errors(self):
        result = {"全局": self.global_entry.errors}
        if self.agenda_catalog_errors:
            result["日程目录"] = {"agenda": self.agenda_catalog_errors}
        result.update({f"会话组 {index + 1}": entry.errors for index, entry in enumerate(self.groups)})
        return {name: errors for name, errors in result.items() if any(errors.values())}

    def blocking_errors(self):
        # In whitelist mode only group-effective feature settings run.
        if not self.groups:
            return self.all_errors()
        result = {f"会话组 {i+1}":entry.errors for i, entry in enumerate(self.groups) if any(entry.errors.values())}
        if self.agenda_catalog_errors:
            result["日程目录"] = {"agenda": self.agenda_catalog_errors}
        global_errors = {key: self.global_entry.errors[key] for key in ("shared", "agenda") if self.global_entry.errors[key]}
        if global_errors:
            result["全局"] = global_errors
        return result


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
        check("shared", "proactive_chat.timezone", lambda: get_timezone(config.timezone), "请输入有效 IANA 时区，例如 Asia/Shanghai。")
        check("shared", "proactive_chat.sleep_hours", lambda: parse_time_ranges(config.sleep_hours),
              "睡眠时段格式应为 HH:MM-HH:MM；多个时段使用英文逗号分隔。")
        if config.missing_group_history not in {"skip", "runtime"}:
            errors["shared"].append(("context.missing_group_history", "请选择 skip 或 runtime。"))
    if config.interjection_enabled:
        if config.debounce_max_seconds < config.debounce_seconds or config.debounce_max_seconds < 0:
            errors["interjection"].append(("interjection.debounce_max_seconds", "最长合并时间不能小于停顿等待时间。"))
        total_weight = sum(abs(weight) for weight in config.weights())
        if total_weight == 0 or not math.isfinite(total_weight):
            errors["interjection"].append(("interjection.weights", "至少一个权重必须不为零，绝对权重总和不能超出有限数值范围。"))
        for index, group in enumerate(config.groups):
            if group.interjection_mode != "关闭":
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
                          ("interjection", "runtime.judgment_concurrency", 1, None, True),
                          ("interjection", "interjection.decision.retry_attempts", 0, 5, True),
                          ("interjection", "interjection.decision.retry_delay_seconds", 0, None, False)]
        if config.proactive_enabled:
            rules += [("proactive", "proactive_chat." + key, low, high, integer) for key, low, high, integer in [
                ("min_interval_minutes", 1, None, True), ("max_interval_minutes", 1, None, True),
                ("daily_limit", 1, None, True), ("active_interval_multiplier", .1, 1, False)]]
            rules += [("proactive", "runtime.proactive_concurrency", 1, None, True),
                      ("proactive", "runtime.proactive_timeout_seconds", 1, None, True)]
        if config.interjection_enabled or config.proactive_enabled:
            rules += [("shared", "context.history_messages", 0, None, True),
                      ("shared", "context.recent_messages", 0, None, True),
                      ("shared", "context.judgment_max_tokens", 256, None, True),
                      ("shared", "context.judgment_max_chars", 1024, None, True),
                      ("shared", "context.message_max_chars", 64, None, True),
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
            if path == "runtime.proactive_timeout_seconds" and isinstance(value, str) and not value.strip():
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
