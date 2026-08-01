"""Signal strength scoring.

Every signal carries a 0-100 score built from named factors, and every factor
keeps a human-readable note. That breakdown is the "почему так" shown in
Telegram and in the app — a number nobody can explain is worse than no number.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Factor:
    name: str
    label: str  # shown to the user, in Russian
    score: float
    maximum: float
    note: str

    @property
    def ratio(self) -> float:
        return self.score / self.maximum if self.maximum else 0.0

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "score": round(self.score, 1),
            "max": self.maximum,
            "note": self.note,
        }


@dataclass
class Score:
    factors: list[Factor] = field(default_factory=list)

    def add(self, name: str, label: str, score: float, maximum: float, note: str) -> None:
        self.factors.append(Factor(name, label, max(0.0, min(score, maximum)), maximum, note))

    @property
    def total(self) -> float:
        return round(sum(f.score for f in self.factors), 1)

    @property
    def grade(self) -> str:
        total = self.total
        if total >= 80:
            return "A"
        if total >= 68:
            return "B"
        if total >= 55:
            return "C"
        return "D"

    def to_dict(self) -> list[dict]:
        return [f.to_dict() for f in self.factors]

    def notes(self) -> list[str]:
        return [f"{f.label}: {f.note} ({f.score:.0f}/{f.maximum:.0f})" for f in self.factors]


def scale(value: float, low: float, high: float, maximum: float) -> float:
    """Map value from [low, high] onto [0, maximum], clamped."""
    if high == low:
        return 0.0
    ratio = (value - low) / (high - low)
    return max(0.0, min(1.0, ratio)) * maximum
