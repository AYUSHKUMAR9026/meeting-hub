CREATE TABLE "document_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"kind" text DEFAULT 'pdf' NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"meeting_date_time" text NOT NULL,
	CONSTRAINT "document_files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_segment_fk";
--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "segment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "citation_start_ms" integer;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "citation_idx" integer;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "citation_speaker" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "result_policy" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE meetings ALTER COLUMN result_policy SET DEFAULT 'temporary';--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "pdf_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "pdf_dirty_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "transcript_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "purge_reason" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "content_retention" text DEFAULT 'pdf_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_meeting_id_workspace_id_meetings_id_workspace_id_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_revision_id_workspace_id_meeting_documents_id_workspace_id_fk" FOREIGN KEY ("revision_id","workspace_id") REFERENCES "public"."meeting_documents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_files_meeting_idx" ON "document_files" USING btree ("workspace_id","meeting_id","generated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_segment_fk" FOREIGN KEY ("segment_id","transcript_id","workspace_id") REFERENCES "public"."transcript_segments"("id","transcript_id","workspace_id") ON DELETE SET NULL (segment_id) ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION mark_meeting_pdf_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid uuid; wid uuid;
BEGIN
  IF TG_TABLE_NAME = 'meeting_documents' THEN
    mid := NEW.meeting_id; wid := NEW.workspace_id;
    IF NOT NEW.is_current THEN RETURN NEW; END IF;
  ELSE
    SELECT meeting_id, workspace_id INTO mid, wid FROM meeting_documents WHERE id = NEW.document_id;
  END IF;
  UPDATE meetings SET pdf_dirty_at = clock_timestamp() WHERE id = mid AND workspace_id = wid;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER document_pdf_dirty AFTER INSERT OR UPDATE OF is_current ON meeting_documents FOR EACH ROW EXECUTE FUNCTION mark_meeting_pdf_dirty();
--> statement-breakpoint
CREATE TRIGGER decision_pdf_dirty AFTER INSERT OR UPDATE ON decisions FOR EACH ROW EXECUTE FUNCTION mark_meeting_pdf_dirty();
--> statement-breakpoint
CREATE TRIGGER action_pdf_dirty AFTER INSERT OR UPDATE ON action_items FOR EACH ROW EXECUTE FUNCTION mark_meeting_pdf_dirty();

--> statement-breakpoint
DROP INDEX "recordings_storage_key_key";--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_storage_key_key" ON "recordings" USING btree ("storage_key") WHERE "recordings"."storage_key" <> '';
--> statement-breakpoint
CREATE TABLE "meeting_invitations" (
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_invitations_meeting_id_invitation_id_pk" PRIMARY KEY("meeting_id","invitation_id")
);
--> statement-breakpoint
ALTER TABLE "meeting_invitations" ADD CONSTRAINT "meeting_invitations_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitations" ADD CONSTRAINT "meeting_invitations_meeting_id_workspace_id_meetings_id_workspace_id_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "meeting_documents" DROP CONSTRAINT "meeting_documents_transcript_fk";
--> statement-breakpoint
ALTER TABLE "action_items" ADD COLUMN "owner_label" text;
--> statement-breakpoint
ALTER TABLE action_items DROP CONSTRAINT action_items_speaker_fk;
--> statement-breakpoint
ALTER TABLE action_items ADD CONSTRAINT action_items_speaker_fk FOREIGN KEY (owner_speaker_id, transcript_id, workspace_id) REFERENCES transcript_speakers(id, transcript_id, workspace_id) ON DELETE SET NULL (owner_speaker_id);

--> statement-breakpoint
CREATE TABLE "room_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_messages_meeting_id_user_id_client_id_unique" UNIQUE("meeting_id","user_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_meeting_id_workspace_id_meetings_id_workspace_id_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_messages_meeting_idx" ON "room_messages" USING btree ("workspace_id","meeting_id","created_at");