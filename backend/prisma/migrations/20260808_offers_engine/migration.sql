-- CreateEnum
CREATE TYPE "OfferType" AS ENUM ('percentage_discount', 'flat_discount', 'buy_x_get_y', 'free_item', 'combo', 'happy_hour', 'festival', 'min_order_value');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "stall_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "OfferType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "min_order_value" DECIMAL(10,2),
    "max_discount" DECIMAL(10,2),
    "discount_percent" INTEGER,
    "discount_flat" DECIMAL(10,2),
    "buy_quantity" INTEGER,
    "get_quantity" INTEGER,
    "free_item_id" TEXT,
    "happy_hour_start" TEXT,
    "happy_hour_end" TEXT,
    "applicable_item_ids" TEXT[],
    "applicable_category_names" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_redemptions" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "discount_amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offers_stall_id_idx" ON "offers"("stall_id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_redemptions_order_id_key" ON "offer_redemptions"("order_id");

-- CreateIndex
CREATE INDEX "offer_redemptions_offer_id_idx" ON "offer_redemptions"("offer_id");

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_stall_id_fkey" FOREIGN KEY ("stall_id") REFERENCES "stalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_free_item_id_fkey" FOREIGN KEY ("free_item_id") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_redemptions" ADD CONSTRAINT "offer_redemptions_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_redemptions" ADD CONSTRAINT "offer_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
