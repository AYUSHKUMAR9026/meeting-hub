-- The composite foreign key meeting_participants_person_fk needs this unique constraint first.
ALTER TABLE "people" ADD CONSTRAINT "people_id_workspace_id_key" UNIQUE("id","workspace_id");
--> statement-breakpoint
CREATE TABLE "meeting_participants" (
	"meeting_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_participants_pkey" PRIMARY KEY("meeting_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"language" text,
	"status" text DEFAULT 'awaiting_upload' NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"external_id" text,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_id_workspace_id_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "meetings_status_check" CHECK ("meetings"."status" IN ('awaiting_upload', 'uploading', 'uploaded', 'processing', 'ready', 'partially_ready', 'failed')),
	CONSTRAINT "meetings_duration_ms_check" CHECK ("meetings"."duration_ms" IS NULL OR "meetings"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text DEFAULT 'original' NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text,
	"duration_ms" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"s3_upload_id" text,
	"part_size" integer,
	"consent_confirmed_by" uuid,
	"consent_confirmed_at" timestamp with time zone,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_kind_check" CHECK ("recordings"."kind" IN ('original', 'normalized')),
	CONSTRAINT "recordings_status_check" CHECK ("recordings"."status" IN ('pending', 'uploading', 'uploaded', 'failed', 'deleted')),
	CONSTRAINT "recordings_size_bytes_check" CHECK ("recordings"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_person_fk" FOREIGN KEY ("person_id","workspace_id") REFERENCES "public"."people"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_consent_confirmed_by_user_id_fk" FOREIGN KEY ("consent_confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_meeting_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_participants_person_id_idx" ON "meeting_participants" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_workspace_id_source_external_id_key" ON "meetings" USING btree ("workspace_id","source","external_id") WHERE "meetings"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "meetings_workspace_id_occurred_at_idx" ON "meetings" USING btree ("workspace_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "meetings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meetings_deleted_at_idx" ON "meetings" USING btree ("deleted_at") WHERE "meetings"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_meeting_id_kind_key" ON "recordings" USING btree ("meeting_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_workspace_id_idempotency_key_key" ON "recordings" USING btree ("workspace_id","idempotency_key") WHERE "recordings"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_storage_key_key" ON "recordings" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "recordings_uploading_created_at_idx" ON "recordings" USING btree ("created_at") WHERE "recordings"."status" = 'uploading';
