CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"created_by" uuid,
	"token_hash" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "share_links_scope_check" CHECK ("share_links"."scope" IN ('document', 'document_and_transcript')),
	CONSTRAINT "share_links_expiry_check" CHECK ("share_links"."expires_at" > "share_links"."created_at" AND "share_links"."expires_at" <= "share_links"."created_at" + interval '2160 hours'),
	CONSTRAINT "share_links_hash_check" CHECK ("share_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "share_links_count_check" CHECK ("share_links"."access_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "sharing_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_meeting_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_links_meeting_idx" ON "share_links" USING btree ("meeting_id","workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "action_items_workspace_due_idx" ON "action_items" USING btree ("workspace_id","status","due_date") WHERE "action_items"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "action_items_workspace_owner_idx" ON "action_items" USING btree ("workspace_id","owner_person_id") WHERE "action_items"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "decisions_workspace_status_idx" ON "decisions" USING btree ("workspace_id","status") WHERE "decisions"."deleted_at" IS NULL;