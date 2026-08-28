#!/usr/bin/env python3
"""Validate the archived Kilt Bowl fixture using only the Python standard library."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def validate_fixture(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    participants = data.get("participants", [])
    if len(participants) != 2:
        raise ValueError("Kilt Bowl fixtures must contain exactly two participants")

    seeds = {int(row["seed"]) for row in participants}
    roster_ids = {int(row["roster_id"]) for row in participants}
    if seeds != {7, 8} or len(roster_ids) != 2:
        raise ValueError("participants must be the unique seventh and eighth seeds")
    if data.get("game_weeks") != [15, 16, 17] or data.get("wins_required") != 2:
        raise ValueError("the canonical series is best-of-three across Weeks 15-17")
    if data.get("winner_rule") != "weekly_official_roster_points":
        raise ValueError("weekly winners must use official Sleeper roster points")
    if data.get("tie_rule") != "higher_seed":
        raise ValueError("tied weekly scores must advance the higher seed")

    seed_by_roster = {int(row["roster_id"]): int(row["seed"]) for row in participants}
    games = data.get("games", [])
    if sorted(int(game["week"]) for game in games) != [15, 16, 17]:
        raise ValueError("the fixture must contain one game for each canonical week")

    computed_wins: Counter[int] = Counter()
    for game in games:
        scores = {int(roster_id): float(score) for roster_id, score in game.get("scores", {}).items()}
        if set(scores) != roster_ids:
            raise ValueError(f"Week {game.get('week')} does not score both participants")
        ordered = sorted(roster_ids, key=lambda roster_id: (-scores[roster_id], seed_by_roster[roster_id]))
        expected_winner = ordered[0]
        if int(game["winner_roster_id"]) != expected_winner:
            raise ValueError(f"Week {game.get('week')} winner conflicts with scores/tiebreak")
        computed_wins[expected_winner] += 1

    published_wins = {int(roster_id): int(wins) for roster_id, wins in data.get("series_wins", {}).items()}
    expected_wins = {roster_id: computed_wins[roster_id] for roster_id in roster_ids}
    if published_wins != expected_wins:
        raise ValueError("series_wins does not match the weekly winners")
    series_winner = max(roster_ids, key=lambda roster_id: (computed_wins[roster_id], -seed_by_roster[roster_id]))
    if computed_wins[series_winner] < int(data["wins_required"]):
        raise ValueError("the published final series has no two-win champion")
    if int(data["winner_roster_id"]) != series_winner:
        raise ValueError("winner_roster_id does not match the computed series champion")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", nargs="?", default="data/kilt-bowl-2025.json", type=Path)
    args = parser.parse_args()
    validate_fixture(args.fixture)
    print(f"Validated {args.fixture}")


if __name__ == "__main__":
    main()
