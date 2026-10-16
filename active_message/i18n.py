"""Shared copy for native settings and the console. Edit .astrbot-plugin/i18n/*.json."""
from __future__ import annotations

import copy
import json
import hashlib
from functools import lru_cache
from pathlib import Path

LOCALES = ("zh-CN", "en-US")
ROOT = Path(__file__).resolve().parents[1] / ".astrbot-plugin" / "i18n"


@lru_cache(maxsize=2)
def catalog(locale: str = "zh-CN") -> dict:
    if locale not in LOCALES:
        locale = "zh-CN"
    return json.loads((ROOT / (locale + ".json")).read_text(encoding="utf-8"))


def catalogs() -> dict:
    return {locale: catalog(locale) for locale in LOCALES}


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
