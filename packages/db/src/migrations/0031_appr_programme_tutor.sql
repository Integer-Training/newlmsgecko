CREATE TABLE "appr_programme_tutor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"tutor_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appr_programme_tutor_unique" UNIQUE("programme_id","tutor_id")
);
--> statement-breakpoint
ALTER TABLE "appr_programme_tutor" ADD CONSTRAINT "appr_programme_tutor_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_programme_tutor" ADD CONSTRAINT "appr_programme_tutor_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "public"."appr_programme"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_programme_tutor" ADD CONSTRAINT "appr_programme_tutor_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appr_programme_tutor" ADD CONSTRAINT "appr_programme_tutor_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appr_programme_tutor_tutor" ON "appr_programme_tutor" USING btree ("tutor_id");