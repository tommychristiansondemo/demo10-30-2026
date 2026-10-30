# Renewable Integration and Ramp Management

> Synthetic training document generated for GridSight AI. Not an official ERCOT publication. Capacities reflect the GridSight simulation.

## Installed capacity in the simulation
- Wind: 40.5 GW, concentrated in WEST, FAR_WEST and the Panhandle (NORTH)
- Solar: 33 GW utility-scale
- Battery storage: 12 GW power capacity

## Diurnal patterns
- **Wind** is typically stronger at night and in spring, weaker in late summer afternoons.
- **Solar** follows the sun's elevation. Peak output near solar noon is around 1 pm CDT; it drops to zero after sunset.
- **Storage** charges midday when solar is abundant and prices are low, then discharges into the evening peak (about 6 to 9 pm CDT).

## The evening net-load ramp
As solar declines and load is still high, net load can rise by more than 4,000 MW in 30 minutes. GridSight raises a `NET_LOAD_RAMP` alert when the 30-minute change exceeds the configured threshold (default 4,500 MW). Mitigations include ECRS deployment, storage dispatch and committing fast-start gas units.

## Wind ramps
Frontal passages can drop wind output by several GW within an hour. GridSight simulates `WIND_RAMP` events of 2.5 to 5 GW with a 45-minute ramp-down. The `STATISTICAL_OUTLIER` detector flags unusually large 5-minute wind changes using a robust z-score (median and MAD), which is resistant to the heavy tails typical of wind data.

## Curtailment
When renewables exceed what the system can absorb (gas at minimum, storage full, export limits), output is curtailed. The `curtailment_mw` field reports it.

## Questions to try with the assistant
- "What share of load did wind and solar serve yesterday afternoon?"
- "How large was the biggest net-load ramp this week, and when?"
- "When does storage usually discharge, and how much?"
