CREATE TABLE "appr_iqa_sample" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"assessor_id" uuid,
	"sampled_by" uuid,
	"outcome" varchar DEFAULT 'PENDING' NOT NULL,
	"feedback" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appr_iqa_sample_evidence_unique" UNIQUE("evidence_id")
);
--> statement-breakpoint
ALTER TABLE "appr_settings" ADD COLUMN "iqa_target_pct" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "appr_iqa_sample" ADD CONSTRAINT "appr_iqa_sample_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_iqa_sample" ADD CONSTRAINT "appr_iqa_sample_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "public"."appr_enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_iqa_sample" ADD CONSTRAINT "appr_iqa_sample_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."appr_evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_iqa_sample" ADD CONSTRAINT "appr_iqa_sample_assessor_id_fkey" FOREIGN KEY ("assessor_id") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_iqa_sample" ADD CONSTRAINT "appr_iqa_sample_sampled_by_fkey" FOREIGN KEY ("sampled_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_iqa_sample" ADD CONSTRAINT "appr_iqa_sample_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_iqa_sample_org_outcome" ON "appr_iqa_sample" USING btree ("organization_id","outcome");--> statement-breakpoint
CREATE INDEX "idx_appr_iqa_sample_assessor" ON "appr_iqa_sample" USING btree ("assessor_id");