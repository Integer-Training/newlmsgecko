CREATE TABLE "appr_glh_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"minutes" integer NOT NULL,
	"log_date" date NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "gateway_items" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "gateway_ready_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "gateway_passed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "gateway_passed_by" uuid;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "epa_booked_date" date;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "epa_result" varchar;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "epa_result_date" date;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "glh_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appr_programme" ADD COLUMN "gateway_checklist" jsonb;--> statement-breakpoint
ALTER TABLE "appr_glh_log" ADD CONSTRAINT "appr_glh_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_glh_log" ADD CONSTRAINT "appr_glh_log_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "public"."appr_enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_glh_log" ADD CONSTRAINT "appr_glh_log_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_glh_log_enrolment" ON "appr_glh_log" USING btree ("enrolment_id");