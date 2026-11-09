CREATE TABLE "appr_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"scheduled_date" date NOT NULL,
	"held_date" date,
	"status" varchar DEFAULT 'SCHEDULED' NOT NULL,
	"snapshot" jsonb,
	"progress_summary" text,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tutor_comment" text,
	"learner_comment" text,
	"employer_comment" text,
	"tutor_signed_name" varchar,
	"tutor_signed_at" timestamp with time zone,
	"tutor_signed_by" uuid,
	"learner_signed_name" varchar,
	"learner_signed_at" timestamp with time zone,
	"employer_signed_name" varchar,
	"employer_signed_at" timestamp with time zone,
	"employer_recorded_by" uuid,
	"next_review_date" date,
	"due_notified_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appr_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"plan_id" uuid,
	"plan_item_id" uuid,
	"title" varchar(256) NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"type_key" varchar NOT NULL,
	"due_date" date,
	"expected_minutes" integer DEFAULT 0 NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar DEFAULT 'PLANNED' NOT NULL,
	"overdue_notified_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appr_task_enrolment_plan_item_unique" UNIQUE("enrolment_id","plan_item_id")
);
--> statement-breakpoint
CREATE TABLE "appr_task_criterion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	CONSTRAINT "appr_task_criterion_unique" UNIQUE("task_id","criterion_id")
);
--> statement-breakpoint
CREATE TABLE "appr_task_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"title" varchar(256) NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appr_task_plan_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"title" varchar(256) NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"type_key" varchar NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"month_offset" integer DEFAULT 0 NOT NULL,
	"expected_minutes" integer DEFAULT 0 NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appr_task_plan_item_criterion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	CONSTRAINT "appr_task_plan_item_criterion_unique" UNIQUE("item_id","criterion_id")
);
--> statement-breakpoint
CREATE TABLE "appr_upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"learner_id" uuid,
	"owner_id" uuid,
	"key" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attached_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	CONSTRAINT "appr_upload_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "appr_evidence" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "appr_programme" ADD COLUMN "review_interval_weeks" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "appr_review" ADD CONSTRAINT "appr_review_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_review" ADD CONSTRAINT "appr_review_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "public"."appr_enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_review" ADD CONSTRAINT "appr_review_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task" ADD CONSTRAINT "appr_task_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task" ADD CONSTRAINT "appr_task_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "public"."appr_enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task" ADD CONSTRAINT "appr_task_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."appr_task_plan"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task" ADD CONSTRAINT "appr_task_plan_item_id_fkey" FOREIGN KEY ("plan_item_id") REFERENCES "public"."appr_task_plan_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task" ADD CONSTRAINT "appr_task_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task_criterion" ADD CONSTRAINT "appr_task_criterion_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."appr_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task_criterion" ADD CONSTRAINT "appr_task_criterion_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "public"."appr_criterion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task_plan" ADD CONSTRAINT "appr_task_plan_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task_plan" ADD CONSTRAINT "appr_task_plan_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "public"."appr_programme"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task_plan" ADD CONSTRAINT "appr_task_plan_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task_plan_item" ADD CONSTRAINT "appr_task_plan_item_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."appr_task_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task_plan_item_criterion" ADD CONSTRAINT "appr_task_plan_item_criterion_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."appr_task_plan_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_task_plan_item_criterion" ADD CONSTRAINT "appr_task_plan_item_criterion_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "public"."appr_criterion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_upload" ADD CONSTRAINT "appr_upload_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_review_enrolment" ON "appr_review" USING btree ("enrolment_id");--> statement-breakpoint
CREATE INDEX "idx_appr_review_org_status_date" ON "appr_review" USING btree ("organization_id","status","scheduled_date");--> statement-breakpoint
CREATE INDEX "idx_appr_task_enrolment" ON "appr_task" USING btree ("enrolment_id");--> statement-breakpoint
CREATE INDEX "idx_appr_task_org_due" ON "appr_task" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE INDEX "idx_appr_task_plan" ON "appr_task" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_appr_task_plan_programme" ON "appr_task_plan" USING btree ("programme_id");--> statement-breakpoint
CREATE INDEX "idx_appr_task_plan_item_plan" ON "appr_task_plan_item" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_appr_upload_pending" ON "appr_upload" USING btree ("attached_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_appr_upload_removed" ON "appr_upload" USING btree ("removed_at");--> statement-breakpoint
CREATE INDEX "idx_appr_evidence_task" ON "appr_evidence" USING btree ("task_id");