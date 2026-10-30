# Runbook: Triage of GridSight Alerts

> Synthetic runbook generated for GridSight AI. Adapt to your organization's procedures.

## General workflow
1. **Acknowledge** the alert (Operator role) so the team knows someone owns it.
2. **Validate data quality** first: is `data_quality` STALE, or is there a STALE_TELEMETRY alert for the same window?
3. **Correlate** with active contingency events in the snapshot (`active_event_details`).
4. **Assess impact** on PRC, frequency and prices.
5. **Act or escalate** per the emergency procedures.
6. **Resolve** with a note summarizing cause and action. Notes are kept in the audit log.

## Alert-specific guidance
### FREQUENCY_EXCURSION
- Likely cause: a unit trip. Check for `UNIT_TRIP` events starting in the same interval.
- Below 59.90 Hz is CRITICAL: confirm RRS deployment and watch PRC recovery over the next 10 to 15 minutes.

### LOW_RESERVES
- Identify the driver (trip, wind ramp, forecast miss, evening ramp).
- Forecast the next 1 to 3 hours of net load. Ask the assistant for a 6-hour load forecast.
- Below the EEA-level threshold: follow the emergency operations summary.

### FORECAST_DEVIATION
- Actual load more than 5% from forecast. Check zone temperatures against expectations.
- Persistent misses justify updating the short-term forecast and considering RUC.

### NET_LOAD_RAMP
- Confirm ramp capability and ECRS and Non-Spin availability for the next 30 to 60 minutes.

### STATISTICAL_OUTLIER (wind)
- Distinguish a real ramp (neighboring zones also drop, frequency dips slightly) from a telemetry glitch (single-interval spike that reverts).

### STALE_TELEMETRY
- A zone load value is frozen for 5 or more intervals. Contact the TSP or QSE and the EMS support desk about the ICCP link.
- Downstream analytics (state estimator, load forecast) for that zone are unreliable until resolved.

### PRICE_SPIKE
- Usually ORDC-driven. Confirm the reserve situation. If PRC is healthy, investigate a modeling or data error.

### CONTINGENCY_* (event alerts)
- Informational record of a contingency. Use it to correlate with the detector alerts above.
