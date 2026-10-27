-- Noordkaai TOS: reporting schema (Oracle 19c+).
-- The simulator's "Download move log" produces rows for MOVE_EVENT;
-- the other tables hold the master data a BI model joins to.

CREATE TABLE vessel_call (
  call_id        VARCHAR2(8)   PRIMARY KEY,         -- V01 …
  vessel_name    VARCHAR2(60)  NOT NULL,
  voyage         VARCHAR2(12)  NOT NULL,
  berth          VARCHAR2(4),
  eta            TIMESTAMP     NOT NULL,
  ata            TIMESTAMP,
  atb            TIMESTAMP,
  atd            TIMESTAMP,
  CONSTRAINT ck_call_order CHECK (atd IS NULL OR atb IS NULL OR atd >= atb)
);

CREATE TABLE container (
  container_no   CHAR(11)      PRIMARY KEY,         -- ISO 6346, check digit validated by the simulator
  iso_type       CHAR(4)       NOT NULL,            -- 22G1, 45G1, 45R1
  category       VARCHAR2(8)   NOT NULL CHECK (category IN ('import', 'export')),
  gross_weight_t NUMBER(5,1)   NOT NULL,
  pod            CHAR(5),                           -- UN/LOCODE, exports only
  call_id        VARCHAR2(8)   REFERENCES vessel_call(call_id),
  is_reefer      NUMBER(1)     DEFAULT 0 NOT NULL
);

CREATE TABLE yard_slot (
  slot_id        VARCHAR2(10)  PRIMARY KEY,         -- A03-2.4 = block A, bay 03, row 2, tier 4
  block_id       CHAR(1)       NOT NULL,
  bay_no         NUMBER(2)     NOT NULL,
  row_no         NUMBER(1)     NOT NULL,
  tier_no        NUMBER(1)     NOT NULL CHECK (tier_no BETWEEN 1 AND 4),
  block_use      VARCHAR2(8)   NOT NULL             -- import / export / reefer
);

CREATE TABLE move_event (
  move_id        NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  move_ts        TIMESTAMP     NOT NULL,
  container_no   CHAR(11)      NOT NULL REFERENCES container(container_no),
  move_kind      VARCHAR2(10)  NOT NULL CHECK (move_kind IN ('yard-in', 'yard-out', 'rehandle')),
  from_loc       VARCHAR2(24),                       -- slot, "V03/hold" or "truck 1-ABC-123"
  to_loc         VARCHAR2(24)
);
CREATE INDEX ix_move_container ON move_event (container_no, move_ts);
CREATE INDEX ix_move_kind_ts   ON move_event (move_kind, move_ts);

CREATE TABLE gate_transaction (
  gate_id        NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  container_no   CHAR(11)      NOT NULL REFERENCES container(container_no),
  truck_plate    VARCHAR2(12)  NOT NULL,
  direction      CHAR(3)       NOT NULL CHECK (direction IN ('IN', 'OUT')),
  lane_no        NUMBER(1),
  event_ts       TIMESTAMP     NOT NULL,
  refused_reason VARCHAR2(40)                        -- e.g. CUSTOMS_HOLD
);

-- Rehandles per 100 retrievals by day: the KPI the yard strategy changes most.
CREATE OR REPLACE VIEW v_rehandle_rate_daily AS
SELECT TRUNC(move_ts)                                                         AS day,
       SUM(CASE WHEN move_kind = 'rehandle' THEN 1 ELSE 0 END)                AS rehandles,
       SUM(CASE WHEN move_kind = 'yard-out' THEN 1 ELSE 0 END)                AS retrievals,
       ROUND(100 * SUM(CASE WHEN move_kind = 'rehandle' THEN 1 ELSE 0 END)
             / NULLIF(SUM(CASE WHEN move_kind = 'yard-out' THEN 1 ELSE 0 END), 0), 1) AS rehandles_per_100
FROM move_event
GROUP BY TRUNC(move_ts);
