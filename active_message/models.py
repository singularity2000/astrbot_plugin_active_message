from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True, frozen=True)
class DecisionResult:
    """判断后端返回的单项分数。"""

    score: float
    reason: str = ""
    backend: str = "unknown"
    model: str = ""
    latency_ms: float = 0.0


@dataclass(slots=True, frozen=True)
class ScoreBreakdown:
    """三项因子的原始分、权重、贡献和最终分。"""

    model_score: float
    activity_score: float
    energy_score: float
    model_weight: float
    activity_weight: float
    energy_weight: float
    model_effective_score: float
    activity_effective_score: float
    energy_effective_score: float
    model_contribution: float
    activity_contribution: float
    energy_contribution: float
    weight_denominator: float
    final_score: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "model": self.model_score,
            "activity": self.activity_score,
            "energy": self.energy_score,
            "weights": {
                "model": self.model_weight,
                "activity": self.activity_weight,
                "energy": self.energy_weight,
            },
            "effective": {
                "model": self.model_effective_score,
                "activity": self.activity_effective_score,
                "energy": self.energy_effective_score,
            },
            "contributions": {
                "model": self.model_contribution,
                "activity": self.activity_contribution,
                "energy": self.energy_contribution,
            },
            "denominator": self.weight_denominator,
            "final": self.final_score,
        }


@dataclass(slots=True, frozen=True)
class MessageObservation:
    timestamp: float
    message_id: str
    sender_id: str
    sender_name: str
    text: str


@dataclass(slots=True)
class SessionRuntimeState:
    """单个 UMO 的短期运行状态，不将聊天正文写入持久化 JSON。"""

    recent_human: list[MessageObservation] = field(default_factory=list)
    recent_bot_timestamps: list[float] = field(default_factory=list)
    last_human_at: float | None = None
    last_bot_at: float | None = None
    last_bot_date: str = ""
    daily_proactive_sent: int = 0
    generation: int = 0
    pending_task: Any = None
    batch_started_at: float | None = None
    judging: bool = False
    evaluation_lock: Any = None
    agent_active: bool = False
    proactive_next_run: str | None = None
    proactive_run_id: str | None = None

    def ensure_lock(self) -> Any:
        if self.evaluation_lock is None:
            import asyncio

            self.evaluation_lock = asyncio.Lock()
        return self.evaluation_lock
