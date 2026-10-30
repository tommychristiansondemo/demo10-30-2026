# Incident Review (Fictional): Evening Net-Peak Scarcity, August

> Fictional incident review generated for GridSight AI training. Any resemblance to real events is coincidental.

## Summary
On a hot weekday in August, a 1,250 MW combined-cycle unit tripped at 6:10 pm CDT, just as solar output was falling and system load was near 79 GW. Wind was below 6 GW because of a stalled high-pressure ridge. PRC fell from about 4,800 MW to 2,900 MW within 10 minutes. System lambda rose above $1,000/MWh as the ORDC adder increased, and frequency reached a nadir of 59.87 Hz.

## Timeline (CDT)
- 17:30: Net load climbing about 3,000 MW per 30 minutes. PRC at 5,200 MW.
- 18:10: Unit trip, 1,250 MW. Frequency nadir 59.87 Hz. GridSight CRITICAL FREQUENCY_EXCURSION alert.
- 18:15: PRC 2,900 MW. WARNING LOW_RESERVES alert. ECRS deployed.
- 18:20: Storage discharge reaches 6.6 GW. Prices above $1,000/MWh.
- 19:05: PRC recovers above 3,500 MW as fast-start gas units come online.
- 20:30: Conditions normal.

## Contributing factors
1. Low wind during the evening ramp.
2. Coincident forced outage of a large unit.
3. A load forecast about 2% low because of an underestimated afternoon temperature.

## What worked
- Storage provided rapid ramping and absorbed most of the gap.
- GridSight alerts reached the control room within 5 minutes of the trip.

## Lessons and follow-ups
- Add a **forecasted PRC** indicator for the next 60 minutes (backlog item GS-142).
- Lower the net-load ramp alert threshold during heat advisories (config change via Admin feature flags).
