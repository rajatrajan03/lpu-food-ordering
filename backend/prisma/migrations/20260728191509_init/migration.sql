-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('placed', 'accepted', 'rejected', 'preparing', 'ready', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "StallStatus" AS ENUM ('active', 'paused');

-- CreateTable
CREATE TABLE "students" (
    "id" TEXT NOT NULL,
    "whatsapp_number" TEXT NOT NULL,
    "name" TEXT,
    "session_state" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stalls" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "area" TEXT,
    "status" "StallStatus" NOT NULL DEFAULT 'active',
    "opening_hours" JSONB,
    "pickup_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stall_owners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stall_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "super_admins" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "super_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "canonical_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" TEXT NOT NULL,
    "stall_id" TEXT NOT NULL,
    "canonical_category_id" TEXT,
    "raw_label" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "stall_id" TEXT NOT NULL,
    "category_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "base_price" DECIMAL(10,2) NOT NULL,
    "is_veg" BOOLEAN,
    "image_url" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "raw_import_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_variants" (
    "id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "item_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_slots" (
    "id" TEXT NOT NULL,
    "stall_id" TEXT NOT NULL,
    "slot_date" DATE NOT NULL,
    "start_time" TIME NOT NULL,
    "end_time" TIME NOT NULL,
    "max_capacity" INTEGER NOT NULL,
    "booked_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pickup_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "stall_id" TEXT NOT NULL,
    "pickup_slot_id" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'placed',
    "total_amount" DECIMAL(10,2) NOT NULL,
    "cancelled_reason" TEXT,
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "item_name_snapshot" TEXT NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_StallOwnerStalls" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "students_whatsapp_number_key" ON "students"("whatsapp_number");

-- CreateIndex
CREATE UNIQUE INDEX "stalls_block_name_key" ON "stalls"("block", "name");

-- CreateIndex
CREATE UNIQUE INDEX "stall_owners_phone_key" ON "stall_owners"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "super_admins_email_key" ON "super_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_categories_name_key" ON "canonical_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "menu_categories_stall_id_raw_label_key" ON "menu_categories"("stall_id", "raw_label");

-- CreateIndex
CREATE INDEX "menu_items_stall_id_idx" ON "menu_items"("stall_id");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_slots_stall_id_slot_date_start_time_key" ON "pickup_slots"("stall_id", "slot_date", "start_time");

-- CreateIndex
CREATE INDEX "orders_stall_id_status_idx" ON "orders"("stall_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "_StallOwnerStalls_AB_unique" ON "_StallOwnerStalls"("A", "B");

-- CreateIndex
CREATE INDEX "_StallOwnerStalls_B_index" ON "_StallOwnerStalls"("B");

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_stall_id_fkey" FOREIGN KEY ("stall_id") REFERENCES "stalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_canonical_category_id_fkey" FOREIGN KEY ("canonical_category_id") REFERENCES "canonical_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_stall_id_fkey" FOREIGN KEY ("stall_id") REFERENCES "stalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_slots" ADD CONSTRAINT "pickup_slots_stall_id_fkey" FOREIGN KEY ("stall_id") REFERENCES "stalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_stall_id_fkey" FOREIGN KEY ("stall_id") REFERENCES "stalls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_pickup_slot_id_fkey" FOREIGN KEY ("pickup_slot_id") REFERENCES "pickup_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "item_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StallOwnerStalls" ADD CONSTRAINT "_StallOwnerStalls_A_fkey" FOREIGN KEY ("A") REFERENCES "stalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StallOwnerStalls" ADD CONSTRAINT "_StallOwnerStalls_B_fkey" FOREIGN KEY ("B") REFERENCES "stall_owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
