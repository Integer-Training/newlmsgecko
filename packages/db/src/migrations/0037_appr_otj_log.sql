CREATE TABLE "appr_otj_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"log_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"is_otj" boolean DEFAULT true NOT NULL,
	"status" varchar DEFAULT 'SUBMITTED' NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appr_otj_log" ADD CONSTRAINT "appr_otj_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_otj_log" ADD CONSTRAINT "appr_otj_log_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "public"."appr_enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_otj_log" ADD CONSTRAINT "appr_otj_log_learner_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_otj_log" ADD CONSTRAINT "appr_otj_log_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_otj_log" ADD CONSTRAINT "appr_otj_log_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_otj_log_enrolment_status" ON "appr_otj_log" USING btree ("enrolment_id","status");--> statement-breakpoint
CREATE INDEX "idx_appr_otj_log_org_status" ON "appr_otj_log" USING btree ("organization_id","status","created_at");