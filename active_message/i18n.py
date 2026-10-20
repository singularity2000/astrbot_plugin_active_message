"""Shared copy for native settings and the console. Edit .astrbot-plugin/i18n/*.json."""
from __future__ import annotations

import copy
import json
import hashlib
from functools import lru_cache
from pathlib import Path

LOCALES = ("zh-CN", "en-US")
ROOT = Path(__file__).resolve().parents[1] / ".astrbot-plugin" / "i18n"
TOOL_LOCALE_KEY = "agenda_tool_locale"


def normalize_locale(locale: str | None) -> str:
    return locale if locale in LOCALES else "zh-CN"


@lru_cache(maxsize=2)
def catalog(locale: str = "zh-CN") -> dict:
    if locale not in LOCALES:
        locale = "zh-CN"
    return json.loads((ROOT / (locale + ".json")).read_text(encoding="utf-8"))


def catalogs() -> dict:
    return {locale: catalog(locale) for locale in LOCALES}


def tool_text(key: str, locale: str = "zh-CN", **values) -> str:
    """Localize plugin-produced tool guidance, never schedule/user content."""
    return catalog(normalize_locale(locale))["tools"]["messages"][key].format(**values)


def tool_error_detail(text: str, locale: str = "zh-CN") -> str:
    """Reuse translations for exact framework/plugin error labels when present."""
    if normalize_locale(locale) == "zh-CN":
        return text
    source = catalog()["pages"]["console"]["runtime"]
    translated = catalog("en-US")["pages"]["console"]["runtime"]
    key = "s" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]
    if key in translated:
        return translated[key]
    return next((translated[key] for key, value in source.items() if value == text and key in translated), text)


def display_text(source: str) -> str:
    """Resolve code-produced labels without interpreting user/model content."""
    key = "s" + hashlib.sha1(source.encode("utf-8")).hexdigest()[:10]
    return catalog()["pages"]["console"]["runtime"].get(key, source)


def localize_schema(schema: dict, locale: str = "zh-CN") -> dict:
    """Only presentation metadata changes; keys, defaults and option values never do."""
    result = copy.deepcopy(schema)
    texts = catalog(locale).get("config", {})

    def visit(fields, translations):
        for key, field in fields.items():
            text = translations.get(key, {})
            for attr in ("description", "hint", "labels", "name"):
                if attr in text:
                    field[attr] = copy.deepcopy(text[attr])
            if field.get("type") == "object" and "items" in field:
                visit(field["items"], text)
            for name, template in field.get("templates", {}).items():
                translated = text.get("templates", {}).get(name, {})
                if "name" in translated:
                    template["name"] = translated["name"]
                visit(template["items"], translated)
    visit(result, texts)
    return result
