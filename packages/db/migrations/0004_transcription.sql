CREATE TABLE "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"speaker_id" uuid NOT NULL,
	"text" text NOT NULL,
	"confidence" real,
	CONSTRAINT "transcript_segments_order_key" UNIQUE("transcript_id","idx"),
	CONSTRAINT "transcript_segments_range_check" CHECK ("transcript_segments"."idx" >= 0 AND "transcript_segments"."start_ms" >= 0 AND "transcript_segments"."end_ms" > "transcript_segments"."start_ms" AND ("transcript_segments"."confidence" IS NULL OR "transcript_segments"."confidence" BETWEEN 0 AND 1))
);
--> statement-breakpoint
CREATE TABLE "transcript_speakers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"person_id" uuid,
	"display_name" text,
	CONSTRAINT "transcript_speakers_transcript_label_key" UNIQUE("transcript_id","label"),
	CONSTRAINT "transcript_speakers_scope_key" UNIQUE("id","transcript_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"processing_run_id" uuid NOT NULL,
	"language" text,
	"provider" text NOT NULL,
	"provider_job_id" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcripts_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "transcripts_run_key" UNIQUE("processing_run_id"),
	CONSTRAINT "transcripts_status_check" CHECK ("transcripts"."status" IN ('pending', 'completed', 'failed') AND (NOT "transcripts"."is_current" OR "transcripts"."status" = 'completed')),
	CONSTRAINT "transcripts_duration_check" CHECK ("transcripts"."duration_ms" > 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "transcript_language" text;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_fk" FOREIGN KEY ("transcript_id","workspace_id") REFERENCES "public"."transcripts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_speaker_fk" FOREIGN KEY ("speaker_id","transcript_id","workspace_id") REFERENCES "public"."transcript_speakers"("id","transcript_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD CONSTRAINT "transcript_speakers_transcript_fk" FOREIGN KEY ("transcript_id","workspace_id") REFERENCES "public"."transcripts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD CONSTRAINT "transcript_speakers_person_fk" FOREIGN KEY ("person_id","workspace_id") REFERENCES "public"."people"("id","workspace_id") ON DELETE SET NULL ("person_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_transcript_scope_key" UNIQUE("id","meeting_id","workspace_id");--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_run_fk" FOREIGN KEY ("processing_run_id","meeting_id","workspace_id") REFERENCES "public"."processing_runs"("id","meeting_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_segments_text_trgm_idx" ON "transcript_segments" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "transcript_speakers_person_idx" ON "transcript_speakers" USING btree ("person_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_current_key" ON "transcripts" USING btree ("meeting_id") WHERE "transcripts"."is_current";--> statement-breakpoint
CREATE INDEX "transcripts_meeting_idx" ON "transcripts" USING btree ("meeting_id","workspace_id");