CREATE TABLE "action_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"transcript_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"edited_by_user" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'ai' NOT NULL,
	"deleted_at" timestamp with time zone,
	"owner_speaker_id" uuid,
	"owner_person_id" uuid,
	"due_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "action_items_scope_key" UNIQUE("id","document_id","workspace_id"),
	CONSTRAINT "action_items_order_key" UNIQUE("document_id","idx"),
	CONSTRAINT "action_items_status_check" CHECK ("action_items"."status" IN ('open', 'done', 'rejected') AND "action_items"."source" IN ('ai', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"transcript_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"edited_by_user" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'ai' NOT NULL,
	"deleted_at" timestamp with time zone,
	"rationale" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	CONSTRAINT "decisions_scope_key" UNIQUE("id","document_id","workspace_id"),
	CONSTRAINT "decisions_order_key" UNIQUE("document_id","idx"),
	CONSTRAINT "decisions_status_check" CHECK ("decisions"."status" IN ('proposed', 'confirmed', 'rejected') AND "decisions"."source" IN ('ai', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"transcript_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"decision_id" uuid GENERATED ALWAYS AS (CASE WHEN item_type = 'decision' THEN item_id END) STORED,
	"action_item_id" uuid GENERATED ALWAYS AS (CASE WHEN item_type = 'action_item' THEN item_id END) STORED,
	CONSTRAINT "evidence_item_segment_key" UNIQUE("document_id","item_type","item_id","segment_id"),
	CONSTRAINT "evidence_item_type_check" CHECK ("evidence"."item_type" IN ('decision', 'action_item'))
);
--> statement-breakpoint
CREATE TABLE "meeting_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"transcript_id" uuid NOT NULL,
	"processing_run_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"summary" jsonb,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"budget_tokens" integer DEFAULT 0 NOT NULL,
	"checkpoints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_documents_run_key" UNIQUE("processing_run_id"),
	CONSTRAINT "meeting_documents_scope_key" UNIQUE("id","transcript_id","workspace_id"),
	CONSTRAINT "meeting_documents_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "meeting_documents_status_check" CHECK ("meeting_documents"."status" IN ('pending', 'completed', 'failed') AND (NOT "meeting_documents"."is_current" OR "meeting_documents"."status" = 'completed') AND ("meeting_documents"."status" <> 'completed' OR "meeting_documents"."summary" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_scope_key" UNIQUE("id","transcript_id","workspace_id");--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_scope_key" UNIQUE("id","meeting_id","workspace_id");--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_document_fk" FOREIGN KEY ("document_id","transcript_id","workspace_id") REFERENCES "public"."meeting_documents"("id","transcript_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_speaker_fk" FOREIGN KEY ("owner_speaker_id","transcript_id","workspace_id") REFERENCES "public"."transcript_speakers"("id","transcript_id","workspace_id") ON DELETE SET NULL ("owner_speaker_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_person_fk" FOREIGN KEY ("owner_person_id","workspace_id") REFERENCES "public"."people"("id","workspace_id") ON DELETE SET NULL ("owner_person_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_document_fk" FOREIGN KEY ("document_id","transcript_id","workspace_id") REFERENCES "public"."meeting_documents"("id","transcript_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_document_fk" FOREIGN KEY ("document_id","transcript_id","workspace_id") REFERENCES "public"."meeting_documents"("id","transcript_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_decision_fk" FOREIGN KEY ("decision_id","document_id","workspace_id") REFERENCES "public"."decisions"("id","document_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_action_item_fk" FOREIGN KEY ("action_item_id","document_id","workspace_id") REFERENCES "public"."action_items"("id","document_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_segment_fk" FOREIGN KEY ("segment_id","transcript_id","workspace_id") REFERENCES "public"."transcript_segments"("id","transcript_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_documents" ADD CONSTRAINT "meeting_documents_meeting_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_documents" ADD CONSTRAINT "meeting_documents_run_fk" FOREIGN KEY ("processing_run_id","meeting_id","workspace_id") REFERENCES "public"."processing_runs"("id","meeting_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_documents" ADD CONSTRAINT "meeting_documents_transcript_fk" FOREIGN KEY ("transcript_id","meeting_id","workspace_id") REFERENCES "public"."transcripts"("id","meeting_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_items_speaker_idx" ON "action_items" USING btree ("owner_speaker_id","transcript_id","workspace_id");--> statement-breakpoint
CREATE INDEX "action_items_person_idx" ON "action_items" USING btree ("owner_person_id","workspace_id");--> statement-breakpoint
CREATE INDEX "evidence_decision_idx" ON "evidence" USING btree ("decision_id","document_id","workspace_id");--> statement-breakpoint
CREATE INDEX "evidence_action_item_idx" ON "evidence" USING btree ("action_item_id","document_id","workspace_id");--> statement-breakpoint
CREATE INDEX "evidence_segment_idx" ON "evidence" USING btree ("segment_id","transcript_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_documents_current_key" ON "meeting_documents" USING btree ("meeting_id") WHERE "meeting_documents"."is_current";--> statement-breakpoint
CREATE INDEX "meeting_documents_history_idx" ON "meeting_documents" USING btree ("meeting_id","workspace_id","created_at" DESC NULLS LAST);