"""集中解析默认值、会话组继承和校验；运行逻辑与页面使用同一份结果。"""
from __future__ import annotations
import copy
import json
import re
from pathlib import Path
from dataclasses import dataclass
from .config import PluginConfig
from .sessions import SessionScopes
from .validation import validate_config
from .agenda import Agenda, normalize_agenda_links, populate_agenda_choices

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "_conf_schema.json"


def schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


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
        self.schema = schema()
        self.shape_errors = shape_errors(raw, self.schema)
        self.raw = fill_defaults(raw, self.schema)
        self.agenda_links_changed = normalize_agenda_links(self.raw)
        if not self.shape_errors:
            populate_agenda_choices(self.schema, self.raw)
        self.config = PluginConfig.from_raw(self.raw)
        self.agenda_catalog_errors = list(Agenda(self.raw["agenda"], max_events=1000).errors)
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
        global_raw["agenda"]["events"] = [e for e in global_raw["agenda"]["events"] if not e.get("group_id")]
        self.global_entry = self._entry(global_raw)
        self.warnings = []
        for index, group in enumerate(self.config.groups):
            if not group.sids:
                self.warnings.append({"code": "EMPTY_SESSION_GROUP", "group_index": index, "message": f"会话组 {index + 1} 没有 SID，不会作用于任何会话；列表非空时仍为白名单模式。"})
        self.groups = []
        self._by_identity = {}
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

    def any_enabled(self, feature=None):
        if not self.config.enabled:
            return False
        entries = self.groups if self.config.groups else [self.global_entry]
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
        agenda = Agenda(raw.get("agenda", {}), origins=origins, timezone_name=config.timezone)
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
        return self.for_group(self.scopes.match(sid)[1])

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
