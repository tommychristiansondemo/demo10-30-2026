# Incident Review (Fictional): Winter Cold Snap, January

> Fictional incident review generated for GridSight AI training. Any resemblance to real events is coincidental.

## Summary
An Arctic front dropped load-weighted temperatures from 55°F to 24°F over 30 hours. Electric heating drove morning load to about 68 GW, a record for that season in the simulation. Gas prices rose by about 30% and planned winter maintenance had about 6 GW of thermal capacity unavailable.

## Observations
- Heating load is very steep below freezing: about 1 GW per °F in the GridSight model.
- Morning peak (7 to 9 am CST) coincided with zero solar output and moderate wind.
- PRC fell to about 3,400 MW at the morning peak: WATCH status, no EEA.
- Load ran 4 to 6% above forecast in NORTH_CENTRAL for several hours (FORECAST_DEVIATION alerts), because the weather model had the front arriving too late.

## Recommendations
1. Weight the forecaster's heating-degree term more heavily below 32°F, or add a separate freeze feature.
2. Review winter planned-outage scheduling against long-range temperature outlooks.
3. Pre-position conservation messaging when the 72-hour forecast exceeds 65 GW.
