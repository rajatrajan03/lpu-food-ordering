-- CreateEnum
CREATE TYPE "MealPeriod" AS ENUM ('breakfast', 'lunch', 'snacks', 'dinner');

-- CreateTable
CREATE TABLE "student_preferences" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "favorite_stall_id" TEXT,
    "favorite_meal_period" "MealPeriod",
    "preferred_area" TEXT,
    "preferred_block" TEXT,
    "usual_order_items" JSONB,
    "favorite_items" JSONB,
    "orders_analyzed" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "student_preferences_student_id_key" ON "student_preferences"("student_id");

-- AddForeignKey
ALTER TABLE "student_preferences" ADD CONSTRAINT "student_preferences_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_preferences" ADD CONSTRAINT "student_preferences_favorite_stall_id_fkey" FOREIGN KEY ("favorite_stall_id") REFERENCES "stalls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
