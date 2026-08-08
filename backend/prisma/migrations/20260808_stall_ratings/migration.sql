-- CreateEnum
CREATE TYPE "RatingReason" AS ENUM ('food_quality', 'service', 'pickup_delay', 'wrong_order', 'other');

-- CreateTable
CREATE TABLE "ratings" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "stall_id" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "reason" "RatingReason",
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ratings_order_id_key" ON "ratings"("order_id");

-- CreateIndex
CREATE INDEX "ratings_stall_id_idx" ON "ratings"("stall_id");

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_stall_id_fkey" FOREIGN KEY ("stall_id") REFERENCES "stalls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
