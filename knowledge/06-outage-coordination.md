# Outage Coordination and Contingency Analysis

> Synthetic training document generated for GridSight AI. Not an official ERCOT publication.

## Planned outages
Generation and transmission owners schedule maintenance in the spring and fall shoulder seasons, when load is lower. In GridSight's simulation, planned thermal outages peak around mid-April and late October at more than 10 GW. This makes **shoulder-season scarcity** possible: a hot early-season day combined with heavy maintenance can tighten reserves as much as a summer peak.

## Forced outages
Forced outages (unit trips) occur without notice: breaker trips, boiler tube leaks, fuel supply loss. GridSight models them as `UNIT_TRIP` events of 400 to 1,400 MW lasting 2 to 10 hours. CRITICAL severity applies to trips of 1,000 MW or more.

## Transmission contingencies
`TRANSMISSION_OUTAGE` events represent a 345 kV line forced outage. While active, SCED manages the post-contingency overload with a binding constraint, which shows up as congestion at nearby trading hubs.

## N-1 security
The system is operated so that loss of any single element does not cause cascading outages, unacceptable voltage or thermal overloads. Real-time contingency analysis (RTCA) in the EMS evaluates thousands of contingencies every few minutes.

## Investigating an event in GridSight
1. Open the alert and note the event id (for example `UNIT_TRIP-202610281415`).
2. Ask the assistant: *"What was the impact of UNIT_TRIP-202610281415 on frequency, PRC and prices?"*
3. Or query directly:
```sql
SELECT * FROM grid_event WHERE event_id = 'UNIT_TRIP-202610281415'
```
then select `grid_interval` rows between `start_ts` and `end_ts`.
