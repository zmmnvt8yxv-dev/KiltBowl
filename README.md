# Kilt Bowl (archived prototype)

This repository preserves the original 2025 Kilt Bowl prototype and its audited
series fixture. The supported implementation now lives inside
[TatnallLegacy](https://github.com/zmmnvt8yxv-dev/TatnallLegacy), where it shares
the canonical Sleeper roster, matchup, scoring, identity, and historical-data
contracts.

## Canonical competition rules

- The participants are the two teams that miss the six-team playoffs in the
  eight-team Tatnall league: seeds 7 and 8.
- Their official Sleeper lineup totals are compared in Weeks 15, 16, and 17,
  even when Sleeper does not create an official head-to-head matchup between
  them.
- The first team to win two weekly games wins the series.
- A tied weekly score is awarded to the higher seed, matching Sleeper's playoff
  tiebreak rule.
- Scores remain provisional while Sleeper can apply stat corrections.

The audited 2025 source fixture is retained at
[`data/kilt-bowl-2025.json`](data/kilt-bowl-2025.json). Git history preserves the
former standalone scoreboard implementation and its large browser-side stats
prototype; those files are intentionally not part of the maintained product.

## Maintained experience

Visit the TatnallLegacy Kilt Bowl page:

<https://zmmnvt8yxv-dev.github.io/TatnallLegacy/events/kilt-bowl/2025>

This repository's Pages entry point redirects there while retaining a visible
fallback link for browsers that block automatic redirects.

Validate the preserved source fixture locally with:

```bash
python3 scripts/validate_fixture.py
```
