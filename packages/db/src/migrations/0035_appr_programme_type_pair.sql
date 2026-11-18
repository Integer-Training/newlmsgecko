ALTER TABLE "appr_programme" ADD COLUMN "type" varchar DEFAULT 'DIPLOMA' NOT NULL;--> statement-breakpoint
ALTER TABLE "appr_programme" ADD COLUMN "paired_programme_id" uuid;--> statement-breakpoint
ALTER TABLE "appr_programme" ADD CONSTRAINT "appr_programme_paired_programme_id_fkey" FOREIGN KEY ("paired_programme_id") REFERENCES "public"."appr_programme"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_programme_paired" ON "appr_programme" USING btree ("paired_programme_id");