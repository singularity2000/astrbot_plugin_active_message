"""集中解析默认值、会话组继承和校验；运行逻辑与页面使用同一份结果。"""
from __future__ import annotations
import copy
import json
from pathlib import Path
from dataclasses import dataclass
from .config import PluginConfig
from .sessions import SessionScopes
from .validation import validate_config

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
            if not isinstance(value, list): errors.append((path, "会话组必须是列表。"))
            else:
                for index, item in enumerate(value):
                    errors.extend(shape_errors(item, spec["templates"]["group"]["items"], f"{path}[{index}]."))
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
            output[key] = [fill_defaults(item, spec["templates"]["group"]["items"]) | {"__template_key": "group"}
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

    def valid(self, feature):
        return not self.errors.get("shared") and not self.errors.get(feature)


class Settings:
    def __init__(self, raw):
        self.schema = schema()
        self.shape_errors = shape_errors(raw, self.schema)
        self.raw = fill_defaults(raw, self.schema)
        self.config = PluginConfig.from_raw(self.raw)
        self.scope_error = ""
        try:
            self.scopes = SessionScopes(self.config)
        except ValueError:
            self.scope_error = "SID 格式错误或重复，请检查会话组。"
            self.scopes = SessionScopes(PluginConfig.from_raw({**self.raw, "session_groups": []}))
        global_raw = copy.deepcopy(self.raw)
        global_raw["session_groups"] = []
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
            entry = self._entry(merged)
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
            if cfg.enabled and any(
                (name == feature or feature is None) and getattr(cfg, name + "_enabled") and entry.valid(name)
                for name in ("interjection", "proactive")
            ):
                return True
        return False

    def _entry(self, raw):
        config = PluginConfig.from_raw(raw)
        errors = validate_config(config, raw)
        errors["shared"].extend(self.shape_errors)
        if self.scope_error:
            errors["shared"].append(("session_groups.sids", self.scope_error))
        # Resource/diagnostic limits remain global and bounded, even with the plugin off.
        for key, low, high in (("max_runs", 1, 500), ("retention_minutes", 1, 1440), ("max_memory_mb", 1, 128), ("max_step_chars", 256, 1048576)):
            value = self.raw.get("diagnostics", {}).get(key)
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                errors["shared"].append(("diagnostics." + key, f"请输入 {low}～{high} 的整数。"))
        return EffectiveSettings(raw, config, errors)

    def for_group(self, group):
        return self._by_identity.get(id(group), self.global_entry)

    def for_sid(self, sid):
        return self.for_group(self.scopes.match(sid)[1])

    def all_errors(self):
        result = {"全局": self.global_entry.errors}
        result.update({f"会话组 {index + 1}": entry.errors for index, entry in enumerate(self.groups)})
        return {name: errors for name, errors in result.items() if any(errors.values())}

    def blocking_errors(self):
        # In whitelist mode only group-effective feature settings run.
        if not self.groups:
            return self.all_errors()
        result = {f"会话组 {i+1}":entry.errors for i, entry in enumerate(self.groups) if any(entry.errors.values())}
        if self.global_entry.errors["shared"]:
            result["全局"] = {"shared":self.global_entry.errors["shared"]}
        return result
