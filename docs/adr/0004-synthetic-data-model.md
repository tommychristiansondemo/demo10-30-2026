# ADR-0004: Deterministic synthetic grid model

**Context.** The platform must look and behave like a real ERCOT tool immediately after deployment, without live feeds, credentials or licensing questions. Tests also need reproducible anomalies.

**Decision.** Generate every value as a pure function of `(timestamp, seed)` (`services/src/data/generator.ts`):
- weather per zone from seasonal + diurnal cycles and smooth hashed noise (multi-day fronts);
- load per zone from time of day, weekday/weekend and convex cooling/heating terms;
- wind and solar from capacity factors (solar from sun elevation at 31°N), storage charging midday and discharging into the evening peak;
- gas balances the system, with coal backdown and renewable curtailment at minimum gas;
- PRC from committed headroom, seasonal planned outages and forced outages;
- frequency dips proportional to MW lost on unit trips;
- system lambda from a gas heat-rate curve plus an ORDC-style logistic adder; hub LMPs add congestion and losses;
- contingency events (unit trips, wind ramps, transmission outages, stale telemetry, forecast misses) drawn from hashed hourly probabilities.

**Consequences.**
- Backfill and live generation always agree, and the 5-minute generator can catch up after gaps.
- Tests can assert that injected events are detected (`services/test`).
- Calibrated to plausible ranges (peaks around 80 GW in summer, rare PRC scarcity, about 9% negative-price intervals), but it is not a market or power-flow model. Don't use it for real operational or trading decisions. Everything in the UI and prompts labels the data as synthetic.
