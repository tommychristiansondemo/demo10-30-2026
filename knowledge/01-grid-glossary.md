# GridSight Glossary: ERCOT Operations and Market Terms

> Synthetic training document generated for GridSight AI. Not an official ERCOT publication. For binding definitions, consult the ERCOT Nodal Protocols and Operating Guides.

**Ancillary Services (AS).** Capacity procured to maintain reliability: Regulation Up (RegUp), Regulation Down (RegDown), Responsive Reserve Service (RRS), ERCOT Contingency Reserve Service (ECRS) and Non-Spinning Reserve (Non-Spin). See "Ancillary Services Overview".

**Day-Ahead Market (DAM).** Financially binding market cleared the day before operations. It co-optimizes energy and ancillary services.

**Real-Time Market (RTM).** Energy dispatched by Security-Constrained Economic Dispatch (SCED) about every five minutes. Settlement uses 15-minute settlement intervals.

**SCED (Security-Constrained Economic Dispatch).** The optimization that sets base points for generators and calculates Locational Marginal Prices (LMPs) every five minutes while respecting transmission constraints.

**System Lambda.** The shadow price of the power balance constraint in SCED: the marginal cost of serving one more MW of load ignoring congestion and losses. In GridSight data it is `system_lambda` ($/MWh).

**LMP (Locational Marginal Price).** Price at a node = energy component + congestion component + loss component. GridSight reports LMPs for five trading hubs: HB_NORTH, HB_HOUSTON, HB_WEST, HB_SOUTH and HB_PAN (Panhandle).

**Trading Hub.** An average of prices across a group of buses, used for bilateral trading and hedging.

**Weather Zone.** A geographic grouping used for load forecasting. ERCOT has eight: COAST, EAST, FAR_WEST, NORTH, NORTH_CENTRAL, SOUTH_CENTRAL, SOUTHERN and WEST. Weather zones differ from load zones, which are used for settlement.

**PRC (Physical Responsive Capability).** A real-time measure of the online capability available to respond quickly to frequency deviations: generation headroom, storage and load resources able to respond. Low PRC is a leading indicator of scarcity and drives emergency procedures. GridSight field: `prc_mw`.

**EEA (Energy Emergency Alert).** A staged emergency declaration used when reserves fall short. Higher levels allow progressively stronger actions, up to directing firm load shed. See "Emergency Operations Summary".

**ORDC (Operating Reserve Demand Curve).** An administrative price adder in the Real-Time Market that rises as available reserves fall, signaling scarcity value. See "Real-Time Pricing and ORDC".

**RUC (Reliability Unit Commitment).** A process ERCOT uses to commit additional units when the market has not committed enough capacity to serve forecast load reliably.

**QSE (Qualified Scheduling Entity).** A market participant that submits offers and schedules and communicates with ERCOT on behalf of resources and load-serving entities.

**TSP / TO (Transmission Service Provider / Owner).** Utility that owns and operates transmission facilities.

**Net Load.** Load minus wind and solar output. Net load ramps, especially at sunset, set the flexibility the rest of the fleet must provide. GridSight field: `net_load_mw`.

**Curtailment.** Reducing wind or solar output below what is available, usually because of transmission constraints or minimum generation limits on other units.

**Contingency.** The unexpected loss of a generator, transmission line or transformer. N-1 planning ensures the system stays secure after any single contingency.

**Frequency Response.** The automatic increase in generation (governor response) and fast-acting resources after a frequency drop. The frequency nadir is the lowest point reached.

**ICCP.** Inter-Control Center Communications Protocol: the telemetry link between ERCOT and market participants or TSPs. Stale ICCP data causes frozen values in the EMS.

**EMS (Energy Management System).** Control-room system for monitoring and controlling the grid: SCADA, state estimation, contingency analysis.

**State Estimator.** EMS application that computes the most likely system state from telemetry. It is sensitive to bad or stale measurements.

**CPT (Central Prevailing Time).** ERCOT's operating time zone: CST in winter, CDT in summer. GridSight stores timestamps in UTC.
