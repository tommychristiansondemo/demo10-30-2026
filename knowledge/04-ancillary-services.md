# Ancillary Services Overview

> Synthetic training document generated for GridSight AI. Not an official ERCOT publication. Quantities are illustrative of the GridSight simulation.

| Service | Purpose | Response time | Typical GridSight award |
|---|---|---|---|
| **Regulation Up (RegUp)** | Continuously corrects small imbalances upward | Seconds, via AGC | 380 to 730 MW |
| **Regulation Down (RegDown)** | Corrects small imbalances downward | Seconds, via AGC | 330 to 530 MW |
| **Responsive Reserve (RRS)** | Arrests frequency decline after contingencies | Within seconds | about 3,000 to 3,400 MW |
| **ERCOT Contingency Reserve Service (ECRS)** | Restores frequency and covers net-load forecast error and ramps | Within 10 minutes | 1,800 to 2,600 MW |
| **Non-Spinning Reserve (Non-Spin)** | Offline or unloaded capacity for longer events | Within 30 minutes | 1,600 to 3,000 MW |

## Why requirements vary by hour
Requirements are larger around the evening net-load peak, when solar drops off and forecast error is highest. GridSight's simulator shapes RegUp, ECRS and Non-Spin with an evening peak and RegDown with a midday peak, when solar variability is largest.

## Relationship to PRC
Ancillary service awards reserve capacity, but PRC measures *physical* responsive capability that is online right now. When AS is deployed during an event, PRC declines. That is why a low-PRC alert during a unit trip is expected and recovers as SCED re-dispatches.

## Data in GridSight
Fields `regup_mw`, `regdown_mw`, `rrs_mw`, `ecrs_mw` and `nonspin_mw` in `grid_interval` hold awards per 5-minute interval.
