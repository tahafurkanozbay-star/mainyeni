-- Kent Rehberi public JSON/GeoJSON API database preparation.
-- Run with an appropriately privileged DBA role during deployment.
-- Do not run CREATE INDEX CONCURRENTLY inside an explicit transaction block.
-- No password, host name or connection string belongs in this file.

-- 1) Least-privilege runtime role.
-- Create/login/password management should be performed by the deployment secret
-- system. This script intentionally does not create a login or embed a password.
GRANT USAGE ON SCHEMA kent_rehberi TO kent_rehberi_select;

GRANT SELECT (
    objectid,
    adi,
    adres,
    ilce,
    mahalle,
    x,
    y,
    tur,
    yapan,
    web_sayfasi,
    durak_no,
    shape
)
ON TABLE kent_rehberi.kent_rehberi_tumu_pggeom
TO kent_rehberi_select;

-- 2) Cursor/order support. ObjectID is expected to behave as the stable ArcGIS
-- row identity. Verify duplicates before relying on keyset pagination.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
    idx_kent_rehberi_tumu_objectid
ON kent_rehberi.kent_rehberi_tumu_pggeom (objectid);

-- Preflight: this should return zero rows. If it returns rows, do not create a
-- unique index and do not use afterObjectId pagination until data is repaired.
SELECT objectid, COUNT(*) AS duplicate_count
FROM kent_rehberi.kent_rehberi_tumu_pggeom
GROUP BY objectid
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, objectid
LIMIT 20;

-- Recommended after the duplicate preflight is clean:
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
--     ux_kent_rehberi_tumu_objectid
-- ON kent_rehberi.kent_rehberi_tumu_pggeom (objectid);
--
-- Cursor safety requires a persistent uniqueness guarantee, not only a one-time
-- clean preflight. Prefer creating the unique index above (after repairing any
-- duplicates). Only while that guarantee remains in place should deployment set:
-- KentRehberiData__ObjectIdCursorEnabled=true
-- The API intentionally rejects afterObjectId while that flag is false.

-- 3) Viewport/bbox queries. This is the primary map navigation index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
    idx_kent_rehberi_tumu_shape_gist
ON kent_rehberi.kent_rehberi_tumu_pggeom
USING GIST (shape)
WHERE shape IS NOT NULL;

-- 4) Meter-accurate nearby queries use geography. The expression index lets
-- ST_DWithin(shape::geography, ...) remain indexable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
    idx_kent_rehberi_tumu_shape_geography_gist
ON kent_rehberi.kent_rehberi_tumu_pggeom
USING GIST ((shape::geography))
WHERE shape IS NOT NULL;

-- 5) Exact case-insensitive administrative filters and stable ordering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
    idx_kent_rehberi_tumu_ilce_objectid
ON kent_rehberi.kent_rehberi_tumu_pggeom
    (lower(ilce), objectid)
WHERE ilce IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS
    idx_kent_rehberi_tumu_mahalle_objectid
ON kent_rehberi.kent_rehberi_tumu_pggeom
    (lower(mahalle), objectid)
WHERE mahalle IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS
    idx_kent_rehberi_tumu_tur_objectid
ON kent_rehberi.kent_rehberi_tumu_pggeom
    (tur, objectid)
WHERE tur IS NOT NULL;

-- 6) Search note:
-- q uses a literal substring ILIKE search across a small bounded set of public
-- text columns. If profiling proves that substring search is hot, consider a
-- DBA-reviewed pg_trgm GIN/GiST strategy. The API does not require pg_trgm and
-- this baseline does not auto-install extensions.

-- 7) Planner statistics should be refreshed after large data loads or index
-- creation. Run under the table owner/maintenance role as appropriate.
ANALYZE kent_rehberi.kent_rehberi_tumu_pggeom;
