-- AlterTable
ALTER TABLE "super_admins" ADD COLUMN     "google_id" TEXT,
ADD COLUMN     "otp_code" TEXT,
ADD COLUMN     "otp_expires_at" TIMESTAMP(3),
ADD COLUMN     "whatsapp_number" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "super_admins_google_id_key" ON "super_admins"("google_id");

