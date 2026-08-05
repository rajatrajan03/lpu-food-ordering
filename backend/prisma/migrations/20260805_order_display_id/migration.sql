-- Random customer-facing order number, decoupled from id/sequence/timing.
ALTER TABLE "orders" ADD COLUMN "display_id" TEXT;

-- Backfill existing rows (all pre-existing rows are internal test data from
-- development, not real order history) so the column can go NOT NULL.
UPDATE "orders"
SET "display_id" = 'ORD-' || upper(substr(md5(random()::text || id::text), 1, 8))
WHERE "display_id" IS NULL;

ALTER TABLE "orders" ALTER COLUMN "display_id" SET NOT NULL;
CREATE UNIQUE INDEX "orders_display_id_key" ON "orders"("display_id");
