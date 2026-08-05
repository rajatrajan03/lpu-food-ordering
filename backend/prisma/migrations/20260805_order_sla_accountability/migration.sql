-- Order SLA & Accountability System: acceptance deadline, SLA violations, no-shows.
ALTER TABLE "orders"
  ADD COLUMN "accept_deadline" TIMESTAMP(3),
  ADD COLUMN "accepted_at" TIMESTAMP(3),
  ADD COLUMN "auto_rejected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ready_at" TIMESTAMP(3),
  ADD COLUMN "sla_violation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sla_violation_minutes" INTEGER,
  ADD COLUMN "no_show" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "no_show_at" TIMESTAMP(3);

ALTER TABLE "stalls" ADD COLUMN "pickup_grace_minutes" INTEGER;
