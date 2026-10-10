from __future__ import annotations

import math
from typing import Iterable

from .models import ScoreBreakdown


def clamp01(value: float) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("scores must be finite numbers")
    return max(0.0, min(1.0, number))


def exceeds_threshold(score: float, threshold: float) -> bool:
    """Ignore rounding noise at equality, matching the Pages score calculator."""
    return score > threshold and not math.isclose(score, threshold, rel_tol=0.0, abs_tol=1e-12)


def normalize_weighted_score(
    scores: Iterable[float],
    weights: Iterable[float],
) -> tuple[float, tuple[float, ...], tuple[float, ...], float]:
    """按绝对权重归一化，负权重先把该项转换为 ``1-score``。"""

    score_values = tuple(clamp01(float(value)) for value in scores)
    weight_values = tuple(float(value) for value in weights)
    if len(score_values) != len(weight_values):
        raise ValueError("scores and weights must have the same length")
    if any(not math.isfinite(value) for value in weight_values):
        raise ValueError("weights must be finite numbers")
    denominator = sum(abs(value) for value in weight_values)
    if not math.isfinite(denominator):
        raise ValueError("sum of absolute weights exceeds the floating-point range")
    if denominator <= 0:
        raise ValueError("at least one weight must be non-zero")
    effective = tuple(
        (1.0 - score) if weight < 0 else score
        for score, weight in zip(score_values, weight_values, strict=True)
    )
    contributions = tuple(
        abs(weight) * score
        for weight, score in zip(weight_values, effective, strict=True)
    )
    final = clamp01(sum(contributions) / denominator)
    return final, effective, contributions, denominator


def calculate_activity_score(
    *,
    message_count: int,
    seconds_since_latest: float | None,
    target_messages: int,
    freshness_seconds: int,
) -> float:
    """将近期真人发言条数与最新消息新鲜度合成 0～1 分。"""

    count_target = max(1, int(target_messages))
    freshness_target = max(1, int(freshness_seconds))
    count_score = clamp01(max(0, int(message_count)) / count_target)
    if seconds_since_latest is None:
        fresh_score = 0.0
    else:
        fresh_score = clamp01(1.0 - max(0.0, float(seconds_since_latest)) / freshness_target)
    return clamp01(count_score * fresh_score)


def calculate_energy_score(
    *,
    recent_bot_count: int,
    target_messages: int,
) -> float:
    """机器人近期说得越少，精力分越高。"""

    target = max(1, int(target_messages))
    return clamp01(1.0 - max(0, int(recent_bot_count)) / target)


def build_score_breakdown(
    *,
    model_score: float,
    activity_score: float,
    energy_score: float,
    model_weight: float,
    activity_weight: float,
    energy_weight: float,
) -> ScoreBreakdown:
    final, effective, contributions, denominator = normalize_weighted_score(
        (model_score, activity_score, energy_score),
        (model_weight, activity_weight, energy_weight),
    )
    return ScoreBreakdown(
        model_score=clamp01(model_score),
        activity_score=clamp01(activity_score),
        energy_score=clamp01(energy_score),
        model_weight=float(model_weight),
        activity_weight=float(activity_weight),
        energy_weight=float(energy_weight),
        model_effective_score=effective[0],
        activity_effective_score=effective[1],
        energy_effective_score=effective[2],
        model_contribution=contributions[0],
        activity_contribution=contributions[1],
        energy_contribution=contributions[2],
        weight_denominator=denominator,
        final_score=final,
    )
