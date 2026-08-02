-- AlterTable
ALTER TABLE "stall_owners" ADD COLUMN     "email" TEXT,
ADD COLUMN     "google_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "stall_owners_email_key" ON "stall_owners"("email");

-- CreateIndex
CREATE UNIQUE INDEX "stall_owners_google_id_key" ON "stall_owners"("google_id");

