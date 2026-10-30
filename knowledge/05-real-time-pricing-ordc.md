# Real-Time Pricing and the Operating Reserve Demand Curve (ORDC)

> Synthetic training document generated for GridSight AI. Simplified. Not an official ERCOT methodology.

## Components of a real-time price
`LMP = system lambda (energy) + congestion + losses`. In ERCOT's real-time market, a reserve price adder from the ORDC is also applied in settlement so that energy prices reflect scarcity.

## How the ORDC adder behaves
The adder is near zero when reserves are plentiful and rises steeply as reserves approach the minimum contingency level, up to the system-wide offer cap. GridSight's simulator approximates it as a logistic function of PRC:

```
adder ≈ 5000 / (1 + exp((PRC − 2500) / 550))   $/MWh
```

So PRC of 6,000 MW adds about $9/MWh, PRC of 3,500 MW adds about $700/MWh, and PRC of 2,500 MW adds about $2,500/MWh. The model is simplified: the real ORDC uses loss-of-load probability and the value of lost load.

## Negative prices
With high wind and solar and low load, especially on spring nights in West Texas, renewable output can exceed what the grid can absorb. Production tax credits let wind resources bid negative, so prices at HB_WEST and HB_PAN often go below zero. GridSight shows these as negative `system_lambda` or negative hub congestion components.

## Congestion patterns in GridSight data
- **HB_WEST and HB_PAN:** negative congestion when wind output is high (export constraints toward load centers).
- **HB_HOUSTON:** positive congestion during high COAST load (import constraints).
- **Transmission outages** add zone-specific congestion while active.

## Useful queries
```sql
-- Hours with the highest average system lambda last week
SELECT date_trunc('hour', ts) AS hour, avg(system_lambda) AS avg_lambda, min(prc_mw) AS min_prc
FROM grid_interval
WHERE dt >= cast(current_date - interval '7' day AS varchar)
GROUP BY 1 ORDER BY avg_lambda DESC LIMIT 10
```
