-- Extensions used across the platform: pgvector (embeddings), pg_trgm (fuzzy search), unaccent (search normalisation).
CREATE EXTENSION IF NOT EXISTS "vector";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "unaccent";
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"workspace_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_workspace_id_key" UNIQUE NULLS NOT DISTINCT("key","workspace_id")
);
--> statement-breakpoint
CREATE INDEX "domain_events_unprocessed_idx" ON "domain_events" USING btree ("created_at") WHERE "domain_events"."processed_at" IS NULL;