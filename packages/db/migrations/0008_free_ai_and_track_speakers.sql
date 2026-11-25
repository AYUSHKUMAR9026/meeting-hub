CREATE TABLE "transcription_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"key" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcription_checkpoints_run_key" UNIQUE("run_id","key")
);
--> statement-breakpoint
ALTER TABLE "action_items" ADD COLUMN "low_confidence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "low_confidence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_documents" ADD COLUMN "low_confidence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "speaker_source" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "external_ai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transcription_checkpoints" ADD CONSTRAINT "transcription_checkpoint_run_fk" FOREIGN KEY ("run_id","meeting_id","workspace_id") REFERENCES "public"."processing_runs"("id","meeting_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD CONSTRAINT "transcript_speakers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Null only optional identity columns, retaining the non-null tenant/revision scope.
ALTER TABLE "transcript_speakers" DROP CONSTRAINT "transcript_speakers_person_fk";
--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD CONSTRAINT "transcript_speakers_person_fk" FOREIGN KEY ("person_id","workspace_id") REFERENCES "people"("id","workspace_id") ON DELETE SET NULL ("person_id");
--> statement-breakpoint
ALTER TABLE "action_items" DROP CONSTRAINT "action_items_person_fk";
--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_person_fk" FOREIGN KEY ("owner_person_id","workspace_id") REFERENCES "people"("id","workspace_id") ON DELETE SET NULL ("owner_person_id");
--> statement-breakpoint
ALTER TABLE "action_items" DROP CONSTRAINT "action_items_speaker_fk";
--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_speaker_fk" FOREIGN KEY ("owner_speaker_id","transcript_id","workspace_id") REFERENCES "transcript_speakers"("id","transcript_id","workspace_id") ON DELETE SET NULL ("owner_speaker_id");
