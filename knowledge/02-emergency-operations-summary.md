# Emergency Operations Summary (EEA Levels): GridSight Training Edition

> Synthetic training document generated for GridSight AI. Simplified for training. Not an official ERCOT procedure. Thresholds below are the values configured in the GridSight environment.

## Purpose
This summary explains how reserve shortfalls escalate into Energy Emergency Alerts (EEA) and which indicators GridSight uses to warn operators early.

## Leading indicators
1. **PRC trend.** Watch both the absolute level and the slope. A steady decline of more than 500 MW per 15 minutes during the evening net-load ramp is a warning sign even when the level is still comfortable.
2. **Net-load ramp.** Sunset solar decline plus a rising evening load can require more than 4,000 MW of upward ramp within 30 minutes.
3. **Forced outages.** A large unit trip removes capacity immediately and depletes responsive reserves through frequency response.
4. **Wind forecast error.** Frontal passages can cause multi-GW wind down-ramps within an hour.
5. **Price signals.** System lambda rising quickly through hundreds of $/MWh usually reflects the ORDC adder as reserves tighten.

## GridSight thresholds (configurable by Admins)
| Condition | PRC | GridSight action |
|---|---|---|
| Normal | ≥ 4,500 MW | None |
| Watch | 3,000 to 4,500 MW | Dashboard shows WATCH status |
| Advisory | < 3,000 MW | WARNING alert "PRC below advisory threshold" |
| EEA-level | < 2,500 MW | CRITICAL alert; review emergency steps |

## Escalation overview (simplified)
- **Conservation appeal / Watch.** Public conservation messaging; confirm all available resources are online; deploy Non-Spin and ECRS as needed.
- **EEA Level 1.** Reserves below the EEA1 threshold and not expected to recover quickly. Use all available generation, emergency purchases over DC ties, and deploy remaining reserves.
- **EEA Level 2.** Reserves fall further. Deploy Emergency Response Service (ERS) and load resources; request voluntary load reduction from large customers.
- **EEA Level 3.** Reserves at the lowest threshold or frequency cannot be maintained. Direct TSPs to shed firm load in rotating blocks to protect the system.

## Operator checklist when GridSight raises a CRITICAL low-reserve alert
1. Confirm the reading: check `data_quality` and the zone telemetry for staleness.
2. Identify the driver: unit trip (see active events), wind ramp, load forecast miss, or a combination.
3. Check net-load trajectory for the next 60 minutes and the load forecast (Forecast page).
4. Review available ECRS and Non-Spin awards and whether they are deployed.
5. Coordinate with the shift supervisor on escalation; document actions in the alert notes. GridSight records them in the audit log.
6. After recovery, resolve the alert with a short summary for the post-event review.
