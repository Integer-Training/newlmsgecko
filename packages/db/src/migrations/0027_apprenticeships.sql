CREATE TABLE "appr_criterion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"code" varchar NOT NULL,
	"text" text NOT NULL,
	"group_label" varchar,
	"required_count" integer DEFAULT 1 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"external_ref" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appr_enrolment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"start_date" date,
	"planned_end_date" date,
	"achieved_at" timestamp with time zone,
	"contracted_hours_week" double precision,
	"otj_target_minutes_override" integer,
	"actual_pct" integer,
	"otj_minutes" integer DEFAULT 0 NOT NULL,
	"submitted_count" integer DEFAULT 0 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"referred_count" integer DEFAULT 0 NOT NULL,
	"recomputed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appr_enrolment_programme_learner_unique" UNIQUE("programme_id","learner_id")
);
--> statement-breakpoint
CREATE TABLE "appr_enrolment_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"start_date" date,
	"target_date" date,
	"completed_at" timestamp with time zone,
	"actual_pct" integer,
	CONSTRAINT "appr_enrolment_unit_unique" UNIQUE("enrolment_id","unit_id")
);
--> statement-breakpoint
CREATE TABLE "appr_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"title" varchar(50) NOT NULL,
	"details" text NOT NULL,
	"type_key" varchar NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"include_otj" boolean DEFAULT false NOT NULL,
	"status" varchar DEFAULT 'SUBMITTED' NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "appr_evidence_criterion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"source" varchar DEFAULT 'LEARNER' NOT NULL,
	CONSTRAINT "appr_evidence_criterion_unique" UNIQUE("evidence_id","criterion_id")
);
--> statement-breakpoint
CREATE TABLE "appr_evidence_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"author_id" uuid,
	"kind" varchar DEFAULT 'GENERAL' NOT NULL,
	"body" text NOT NULL,
	"status_at_time" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appr_evidence_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar NOT NULL,
	"label" varchar NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "appr_evidence_type_org_key_unique" UNIQUE("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "appr_programme" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" varchar NOT NULL,
	"description" text,
	"reference" varchar,
	"level" varchar,
	"status" varchar DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appr_qualification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"title" varchar NOT NULL,
	"reference" varchar,
	"awarding_body" varchar,
	"level" varchar,
	"sort" integer DEFAULT 0 NOT NULL,
	"external_ref" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appr_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"concern_gap_pct" integer DEFAULT 15 NOT NULL,
	"otj_factor" double precision DEFAULT 0.2 NOT NULL,
	"otj_weekly_cap_hours" double precision DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appr_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qualification_id" uuid NOT NULL,
	"code" varchar,
	"title" varchar NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"glh" integer,
	"external_ref" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appr_criterion" ADD CONSTRAINT "appr_criterion_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."appr_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD CONSTRAINT "appr_enrolment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD CONSTRAINT "appr_enrolment_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "public"."appr_programme"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD CONSTRAINT "appr_enrolment_learner_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD CONSTRAINT "appr_enrolment_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_enrolment_unit" ADD CONSTRAINT "appr_enrolment_unit_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "public"."appr_enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_enrolment_unit" ADD CONSTRAINT "appr_enrolment_unit_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."appr_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence" ADD CONSTRAINT "appr_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence" ADD CONSTRAINT "appr_evidence_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "public"."appr_programme"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence" ADD CONSTRAINT "appr_evidence_learner_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence" ADD CONSTRAINT "appr_evidence_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence" ADD CONSTRAINT "appr_evidence_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence_criterion" ADD CONSTRAINT "appr_evidence_criterion_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."appr_evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence_criterion" ADD CONSTRAINT "appr_evidence_criterion_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "public"."appr_criterion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence_note" ADD CONSTRAINT "appr_evidence_note_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."appr_evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence_note" ADD CONSTRAINT "appr_evidence_note_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_evidence_type" ADD CONSTRAINT "appr_evidence_type_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_programme" ADD CONSTRAINT "appr_programme_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_programme" ADD CONSTRAINT "appr_programme_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_qualification" ADD CONSTRAINT "appr_qualification_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_qualification" ADD CONSTRAINT "appr_qualification_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "public"."appr_programme"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_settings" ADD CONSTRAINT "appr_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_unit" ADD CONSTRAINT "appr_unit_qualification_id_fkey" FOREIGN KEY ("qualification_id") REFERENCES "public"."appr_qualification"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_criterion_unit" ON "appr_criterion" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "idx_appr_enrolment_org" ON "appr_enrolment" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_appr_enrolment_learner" ON "appr_enrolment" USING btree ("learner_id");--> statement-breakpoint
CREATE INDEX "idx_appr_evidence_learner_programme_status" ON "appr_evidence" USING btree ("learner_id","programme_id","status");--> statement-breakpoint
CREATE INDEX "idx_appr_evidence_org_status_created" ON "appr_evidence" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_appr_evidence_criterion_criterion" ON "appr_evidence_criterion" USING btree ("criterion_id");--> statement-breakpoint
CREATE INDEX "idx_appr_evidence_note_evidence" ON "appr_evidence_note" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "idx_appr_programme_org" ON "appr_programme" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_appr_qualification_programme" ON "appr_qualification" USING btree ("programme_id");--> statement-breakpoint
CREATE INDEX "idx_appr_unit_qualification" ON "appr_unit" USING btree ("qualification_id");