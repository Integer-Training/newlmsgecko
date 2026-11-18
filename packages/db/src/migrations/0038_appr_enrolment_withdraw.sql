ALTER TABLE "appr_enrolment" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "withdrawn_by" uuid;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD COLUMN "withdrawal_reason" text;--> statement-breakpoint
ALTER TABLE "appr_enrolment" ADD CONSTRAINT "appr_enrolment_withdrawn_by_fkey" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;