CREATE TABLE "appr_onboarding_doc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"doc_type_id" uuid NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"not_held" boolean DEFAULT false NOT NULL,
	"learner_note" text,
	"status" varchar DEFAULT 'SUBMITTED' NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appr_onboarding_doc_unique" UNIQUE("enrolment_id","doc_type_id")
);
--> statement-breakpoint
CREATE TABLE "appr_onboarding_doc_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid,
	"label" varchar(120) NOT NULL,
	"description" text,
	"required" boolean DEFAULT true NOT NULL,
	"allow_not_held" boolean DEFAULT false NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appr_onboarding_doc" ADD CONSTRAINT "appr_onboarding_doc_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_onboarding_doc" ADD CONSTRAINT "appr_onboarding_doc_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "public"."appr_enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_onboarding_doc" ADD CONSTRAINT "appr_onboarding_doc_learner_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_onboarding_doc" ADD CONSTRAINT "appr_onboarding_doc_doc_type_id_fkey" FOREIGN KEY ("doc_type_id") REFERENCES "public"."appr_onboarding_doc_type"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_onboarding_doc" ADD CONSTRAINT "appr_onboarding_doc_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_onboarding_doc" ADD CONSTRAINT "appr_onboarding_doc_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_onboarding_doc_type" ADD CONSTRAINT "appr_onboarding_doc_type_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_onboarding_doc_type" ADD CONSTRAINT "appr_onboarding_doc_type_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "public"."appr_programme"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_onboarding_doc_org_status" ON "appr_onboarding_doc" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_appr_onboarding_doc_type_org" ON "appr_onboarding_doc_type" USING btree ("organization_id","sequence");