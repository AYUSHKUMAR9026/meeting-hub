CREATE TABLE "room_attendance" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"user_id" uuid,
	"person_id" uuid,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"consent_acknowledged_at" timestamp with time zone,
	CONSTRAINT "room_attendance_id_meeting_id_workspace_id_unique" UNIQUE("id","meeting_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "room_exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"attendance_id" uuid,
	"source_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"egress_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_exports_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "room_exports_egress_id_unique" UNIQUE("egress_id"),
	CONSTRAINT "room_exports_session_id_source_id_unique" UNIQUE("session_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "room_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "room_sessions_id_meeting_id_workspace_id_unique" UNIQUE("id","meeting_id","workspace_id"),
	CONSTRAINT "room_sessions_end_check" CHECK (("room_sessions"."ended_at" IS NULL) = ("room_sessions"."end_reason" IS NULL) AND "room_sessions"."end_reason" IN ('host_ended','empty_timeout','max_duration','error'))
);
--> statement-breakpoint
CREATE TABLE "room_webhook_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_webhook_receipts_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "recordings" DROP CONSTRAINT "recordings_kind_check";--> statement-breakpoint
DROP INDEX "recordings_meeting_id_kind_key";--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "room_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "room_name" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "room_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "room_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "recording_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "attendance_id" uuid;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "start_offset_ms" integer;--> statement-breakpoint
ALTER TABLE "room_attendance" ADD CONSTRAINT "room_attendance_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_attendance" ADD CONSTRAINT "attendance_session_fk" FOREIGN KEY ("session_id","meeting_id","workspace_id") REFERENCES "public"."room_sessions"("id","meeting_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_attendance" ADD CONSTRAINT "attendance_person_fk" FOREIGN KEY ("person_id","workspace_id") REFERENCES "public"."people"("id","workspace_id") ON DELETE SET NULL ("person_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_exports" ADD CONSTRAINT "room_export_session_fk" FOREIGN KEY ("session_id","meeting_id","workspace_id") REFERENCES "public"."room_sessions"("id","meeting_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_exports" ADD CONSTRAINT "room_export_attendance_fk" FOREIGN KEY ("attendance_id","meeting_id","workspace_id") REFERENCES "public"."room_attendance"("id","meeting_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_sessions" ADD CONSTRAINT "room_sessions_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_sessions" ADD CONSTRAINT "room_sessions_meeting_id_workspace_id_meetings_id_workspace_id_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_webhook_receipts" ADD CONSTRAINT "room_webhook_session_fk" FOREIGN KEY ("session_id","meeting_id","workspace_id") REFERENCES "public"."room_sessions"("id","meeting_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_active_user" ON "room_attendance" USING btree ("session_id","user_id") WHERE "room_attendance"."left_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "room_sessions_one_active" ON "room_sessions" USING btree ("meeting_id") WHERE "room_sessions"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "room_sessions_active_workspace" ON "room_sessions" USING btree ("workspace_id") WHERE "room_sessions"."ended_at" IS NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recording_attendance_fk" FOREIGN KEY ("attendance_id","meeting_id","workspace_id") REFERENCES "public"."room_attendance"("id","meeting_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_one_source_key" ON "recordings" USING btree ("meeting_id") WHERE "recordings"."kind" IN ('original','mixed_audio');--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_meeting_id_kind_key" ON "recordings" USING btree ("meeting_id","kind") WHERE "recordings"."kind" <> 'participant_track';--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_room_name_unique" UNIQUE("room_name");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_room_status_check" CHECK ("meetings"."room_status" IN ('none','scheduled','live','ended'));--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_track_check" CHECK (CASE WHEN "recordings"."kind" = 'participant_track' THEN "recordings"."attendance_id" IS NOT NULL AND "recordings"."start_offset_ms" IS NOT NULL AND "recordings"."start_offset_ms" >= 0 ELSE "recordings"."attendance_id" IS NULL AND "recordings"."start_offset_ms" IS NULL END);--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_kind_check" CHECK ("recordings"."kind" IN ('original', 'normalized', 'mixed_audio', 'participant_track'));