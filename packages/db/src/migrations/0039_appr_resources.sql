CREATE TABLE "appr_resource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"unit_id" uuid,
	"kind" varchar NOT NULL,
	"title" varchar(256) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"file" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"status" varchar DEFAULT 'ACTIVE' NOT NULL,
	"evidence_type_key" varchar,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appr_resource_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"first_viewed_at" timestamp with time zone,
	"first_downloaded_at" timestamp with time zone,
	"last_downloaded_at" timestamp with time zone,
	"download_count" integer DEFAULT 0 NOT NULL,
	"last_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "appr_resource_activity_unique" UNIQUE("resource_id","enrolment_id")
);
--> statement-breakpoint
CREATE TABLE "appr_resource_criterion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	CONSTRAINT "appr_resource_criterion_unique" UNIQUE("resource_id","criterion_id")
);
--> statement-breakpoint
ALTER TABLE "appr_evidence" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "appr_resource" ADD CONSTRAINT "appr_resource_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_resource" ADD CONSTRAINT "appr_resource_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "public"."appr_programme"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_resource" ADD CONSTRAINT "appr_resource_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."appr_unit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_resource" ADD CONSTRAINT "appr_resource_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_resource_activity" ADD CONSTRAINT "appr_resource_activity_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."appr_resource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_resource_activity" ADD CONSTRAINT "appr_resource_activity_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "public"."appr_enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_resource_activity" ADD CONSTRAINT "appr_resource_activity_learner_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_resource_criterion" ADD CONSTRAINT "appr_resource_criterion_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."appr_resource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_resource_criterion" ADD CONSTRAINT "appr_resource_criterion_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "public"."appr_criterion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_resource_programme_status" ON "appr_resource" USING btree ("programme_id","status");--> statement-breakpoint
CREATE INDEX "idx_appr_resource_unit" ON "appr_resource" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "idx_appr_resource_org" ON "appr_resource" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_appr_resource_activity_learner" ON "appr_resource_activity" USING btree ("learner_id");--> statement-breakpoint
CREATE INDEX "idx_appr_resource_criterion_criterion" ON "appr_resource_criterion" USING btree ("criterion_id");--> statement-breakpoint
ALTER TABLE "appr_evidence" ADD CONSTRAINT "appr_evidence_resource_id_appr_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."appr_resource"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_evidence_resource" ON "appr_evidence" USING btree ("resource_id");