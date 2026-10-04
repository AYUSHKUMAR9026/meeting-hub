-- The composite foreign key processing_runs_recording_fk needs this unique constraint first.
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_id_workspace_id_key" UNIQUE("id","workspace_id");
--> statement-breakpoint
CREATE TABLE "processing_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"pipeline_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"current_step" text,
	"error_code" text,
	"error_message" text,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_runs_id_workspace_id_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "processing_runs_status_check" CHECK ("processing_runs"."status" IN ('queued', 'preparing_media', 'transcribing', 'analyzing', 'indexing', 'completed', 'partially_ready', 'failed', 'cancelled')),
	CONSTRAINT "processing_runs_trigger_check" CHECK ("processing_runs"."trigger" IN ('upload', 'reprocess')),
	CONSTRAINT "processing_runs_pipeline_version_check" CHECK ("processing_runs"."pipeline_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "processing_steps" (
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"error_detail" text,
	"external_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_steps_pkey" PRIMARY KEY("run_id","name"),
	CONSTRAINT "processing_steps_run_id_position_key" UNIQUE("run_id","position"),
	CONSTRAINT "processing_steps_status_check" CHECK ("processing_steps"."status" IN ('pending', 'running', 'waiting_external', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "processing_steps_attempts_check" CHECK ("processing_steps"."attempts" >= 0)
);
--> statement-breakpoint
DROP INDEX "domain_events_unprocessed_idx";--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "codec" text;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "sample_rate" integer;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "channels" integer;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "peaks_storage_key" text;--> statement-breakpoint
ALTER TABLE "domain_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_events" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "domain_events" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_meeting_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_recording_fk" FOREIGN KEY ("recording_id","workspace_id") REFERENCES "public"."recordings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_steps" ADD CONSTRAINT "processing_steps_run_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."processing_runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "processing_runs_one_active_per_meeting_key" ON "processing_runs" USING btree ("meeting_id") WHERE "processing_runs"."status" IN ('queued', 'preparing_media', 'transcribing', 'analyzing', 'indexing');--> statement-breakpoint
CREATE UNIQUE INDEX "processing_runs_upload_per_recording_key" ON "processing_runs" USING btree ("recording_id","trigger") WHERE "processing_runs"."trigger" = 'upload';--> statement-breakpoint
CREATE INDEX "processing_runs_meeting_id_created_at_idx" ON "processing_runs" USING btree ("meeting_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "processing_runs_active_idx" ON "processing_runs" USING btree ("updated_at") WHERE "processing_runs"."status" IN ('queued', 'preparing_media', 'transcribing', 'analyzing', 'indexing');--> statement-breakpoint
CREATE INDEX "domain_events_unprocessed_idx" ON "domain_events" USING btree ("created_at","id") WHERE "domain_events"."processed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_audio_props_check" CHECK (("recordings"."sample_rate" IS NULL OR "recordings"."sample_rate" > 0) AND ("recordings"."channels" IS NULL OR "recordings"."channels" > 0));