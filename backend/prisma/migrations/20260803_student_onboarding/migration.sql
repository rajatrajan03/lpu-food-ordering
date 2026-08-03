-- Rename last_active_at -> last_seen (same meaning, matches onboarding spec's field name)
ALTER TABLE "students" RENAME COLUMN "last_active_at" TO "last_seen";

-- AlterTable
ALTER TABLE "students"
  ADD COLUMN "registration_number" TEXT,
  ADD COLUMN "preferred_language" TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
