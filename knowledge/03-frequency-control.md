# Frequency Control and Response

> Synthetic training document generated for GridSight AI. Not an official ERCOT publication.

## Nominal frequency and normal band
ERCOT is an asynchronous interconnection that runs at a nominal 60 Hz. Under normal conditions frequency stays within about ±0.02 Hz. GridSight raises an alert when the 5-minute minimum falls below **59.95 Hz** or the maximum exceeds **60.05 Hz** (both configurable).

## What happens after a generator trip
1. **Inertial response (0 to 2 s).** Rotating mass slows the rate of change of frequency (RoCoF). Lower inertia, common with high inverter-based output, means faster decline.
2. **Fast frequency response and load resources (under 1 s to a few seconds).** Batteries and under-frequency relay load resources respond quickly.
3. **Primary frequency response (2 to 30 s).** Governors increase output. The frequency **nadir** is reached.
4. **Secondary response (minutes).** Regulation and SCED restore frequency to 60 Hz and replace deployed reserves.

## Rule of thumb used in GridSight's simulator
The simulator models nadir depth as roughly **85 mHz per 1,000 MW lost**. A 1,300 MW trip yields a nadir near 59.88 Hz, which triggers a CRITICAL alert below 59.90 Hz. Real system response depends on inertia, headroom and the online resource mix.

## Investigating a frequency excursion
- Correlate the excursion timestamp with `grid_event` rows of type `UNIT_TRIP`.
- Check PRC immediately before and after; PRC drops as reserves deploy.
- Example SQL:
```sql
SELECT g.ts, g.freq_min_hz, g.prc_mw, e.event_id, e.mw_impact
FROM grid_interval g
LEFT JOIN grid_event e ON e.start_ts = g.ts AND e.type = 'UNIT_TRIP'
WHERE g.dt >= '2026-10-01' AND g.freq_min_hz < 59.95
ORDER BY g.ts DESC
```

## Over-frequency
Over-frequency follows a sudden loss of load or excessive regulation-up. It is rarer and usually less severe, but large inverter-based resources must ride through and respond with reduced output.
