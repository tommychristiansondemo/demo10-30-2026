# Weather and Load Forecasting

> Synthetic training document generated for GridSight AI. Not an official ERCOT publication.

## Drivers of Texas load
- **Temperature** dominates. Air-conditioning load rises convexly above about 70°F, and electric heating load rises sharply in hard freezes.
- **Time of day and day of week.** Morning ramp, afternoon plateau and an evening peak; weekends are 6 to 8 percent lower.
- **Industrial load** in FAR_WEST (oil and gas) is relatively flat.

## GridSight's forecasting model
GridSight ships a transparent baseline: **ridge regression** on hourly load with features
- hour-of-day indicators, separately for weekdays and weekends
- cooling degree-hours above 65°F and their square
- heating degree-hours below 55°F
- cooling degree-hours during daytime hours

It trains on the last 28 days of hourly data, issues forecasts up to 72 hours ahead with P10 and P90 bands from empirical residual quantiles (widened with horizon), and reports a **24-hour backtest MAPE** next to a seasonal-naive baseline (same hour last week).

## Interpreting accuracy
- MAPE below 3% day-ahead is good for a system-level forecast.
- Error grows with weather forecast error. Frontal passages and convective storms are the biggest sources.
- Compare against `load_forecast_mw`, the operational forecast stored with each interval.

## Extending the forecaster
Developers can replace `services/src/analytics/forecast.ts` with a gradient-boosted model or call an Amazon SageMaker endpoint. Keep the `ForecastResult` shape so the UI and the AI tool continue to work. See the developer guide.
