CREATE TABLE "item_status_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "item_status_events_status_check" CHECK (("item_status_events"."item_type" = 'decision' AND "item_status_events"."to_status" IN ('proposed','confirmed','rejected') AND ("item_status_events"."from_status" IS NULL OR "item_status_events"."from_status" IN ('proposed','confirmed','rejected'))) OR ("item_status_events"."item_type" = 'action_item' AND "item_status_events"."to_status" IN ('open','done','rejected') AND ("item_status_events"."from_status" IS NULL OR "item_status_events"."from_status" IN ('open','done','rejected'))))
);
--> statement-breakpoint
CREATE TABLE "progress_refresh_requests" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"open_count" integer NOT NULL,
	"done_count" integer NOT NULL,
	"overdue_count" integer NOT NULL,
	"proposed_count" integer NOT NULL,
	"rejected_count" integer NOT NULL,
	"decisions_proposed" integer NOT NULL,
	"decisions_confirmed" integer NOT NULL,
	"meetings_count" integer NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progress_snapshots_workspace_date_key" UNIQUE("workspace_id","snapshot_date"),
	CONSTRAINT "progress_snapshot_counts_check" CHECK ("progress_snapshots"."open_count" >= 0 AND "progress_snapshots"."done_count" >= 0 AND "progress_snapshots"."overdue_count" BETWEEN 0 AND "progress_snapshots"."open_count" AND "progress_snapshots"."proposed_count" >= 0 AND "progress_snapshots"."rejected_count" >= 0 AND "progress_snapshots"."decisions_proposed" >= 0 AND "progress_snapshots"."decisions_confirmed" >= 0 AND "progress_snapshots"."meetings_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "item_status_events" ADD CONSTRAINT "item_status_events_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_status_events" ADD CONSTRAINT "item_status_events_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_status_events" ADD CONSTRAINT "item_status_events_meeting_fk" FOREIGN KEY ("meeting_id","workspace_id") REFERENCES "public"."meetings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_refresh_requests" ADD CONSTRAINT "progress_refresh_requests_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_snapshots" ADD CONSTRAINT "progress_snapshots_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_status_events_range_idx" ON "item_status_events" USING btree ("workspace_id","changed_at");--> statement-breakpoint
CREATE INDEX "item_status_events_item_idx" ON "item_status_events" USING btree ("workspace_id","item_type","item_id","changed_at");--> statement-breakpoint
CREATE INDEX "item_status_events_meeting_idx" ON "item_status_events" USING btree ("meeting_id","workspace_id");--> statement-breakpoint
CREATE INDEX "progress_refresh_requests_due_idx" ON "progress_refresh_requests" USING btree ("available_at");
--> statement-breakpoint
-- Status events are enforced at the database boundary, including bulk review and future routes.
-- The actor is a transaction-local setting supplied by DocumentService; pipeline writes are null.
CREATE FUNCTION progress_item_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid uuid;
BEGIN
  SELECT meeting_id INTO mid FROM meeting_documents WHERE id = NEW.document_id AND workspace_id = NEW.workspace_id;
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO item_status_events(workspace_id, item_type, item_id, meeting_id, from_status, to_status, changed_by)
    VALUES (NEW.workspace_id, CASE TG_TABLE_NAME WHEN 'decisions' THEN 'decision' ELSE 'action_item' END,
      NEW.id, mid, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status,
      nullif(current_setting('app.progress_actor', true), '')::uuid);
  END IF;
  INSERT INTO domain_events(type, payload) VALUES ('progress.changed', jsonb_build_object('workspaceId', NEW.workspace_id));
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER progress_decision_change AFTER INSERT OR UPDATE ON decisions FOR EACH ROW EXECUTE FUNCTION progress_item_change();
--> statement-breakpoint
CREATE TRIGGER progress_action_change AFTER INSERT OR UPDATE ON action_items FOR EACH ROW EXECUTE FUNCTION progress_item_change();
--> statement-breakpoint
CREATE FUNCTION progress_document_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_current AND (TG_OP = 'INSERT' OR NOT OLD.is_current) THEN
    INSERT INTO domain_events(type, payload) VALUES ('progress.changed', jsonb_build_object('workspaceId', NEW.workspace_id));
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER progress_document_current AFTER INSERT OR UPDATE OF is_current ON meeting_documents FOR EACH ROW EXECUTE FUNCTION progress_document_change();
--> statement-breakpoint
CREATE FUNCTION progress_meeting_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Historical aggregates contain no meeting IDs or content and retain the observations made
  -- on those dates. Meeting-owned status events cascade; today's live aggregate is refreshed.
  IF TG_OP = 'DELETE' THEN
    INSERT INTO domain_events(type, payload) VALUES ('progress.changed', jsonb_build_object('workspaceId', OLD.workspace_id));
    RETURN OLD;
  END IF;
  INSERT INTO domain_events(type, payload) VALUES ('progress.changed', jsonb_build_object('workspaceId', NEW.workspace_id));
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER progress_meeting_dirty AFTER INSERT OR UPDATE OF deleted_at, occurred_at ON meetings FOR EACH ROW EXECUTE FUNCTION progress_meeting_change();
--> statement-breakpoint
CREATE TRIGGER progress_meeting_purge BEFORE DELETE ON meetings FOR EACH ROW EXECUTE FUNCTION progress_meeting_change();
--> statement-breakpoint
-- Legacy audits recorded edited field names, not old/new status values. Only explicit bulk
-- review has a known status; do not pretend an edit time is a completion time.
INSERT INTO item_status_events(workspace_id, item_type, item_id, meeting_id, from_status, to_status, changed_at, backfilled)
SELECT i.workspace_id, i.kind, i.id, d.meeting_id, NULL, i.status,
  coalesce((SELECT max(a.created_at) FROM audit_logs a WHERE a.workspace_id = i.workspace_id
    AND a.action = 'analysis.items_reviewed' AND a.target_id = d.meeting_id::text
    AND a.metadata->>'status' = i.status AND a.metadata->'decisionIds' ? i.id::text),
    CASE WHEN i.status IN ('open', 'proposed') THEN d.created_at ELSE now() END), true
FROM (SELECT id, workspace_id, document_id, status, 'decision' AS kind FROM decisions
      UNION ALL SELECT id, workspace_id, document_id, status, 'action_item' AS kind FROM action_items) i
JOIN meeting_documents d ON d.id = i.document_id AND d.workspace_id = i.workspace_id;
--> statement-breakpoint
-- One truthful baseline today; there is insufficient legacy information to invent past totals.
INSERT INTO progress_snapshots(workspace_id, snapshot_date, open_count, done_count, overdue_count,
  proposed_count, rejected_count, decisions_proposed, decisions_confirmed, meetings_count, backfilled)
SELECT s.workspace_id, (now() AT TIME ZONE s.timezone)::date,
  coalesce(a.open,0), coalesce(a.done,0), coalesce(a.overdue,0), coalesce(c.proposed,0),
  coalesce(a.rejected,0) + coalesce(c.rejected,0), coalesce(c.proposed,0), coalesce(c.confirmed,0),
  (SELECT count(*)::int FROM meetings m WHERE m.workspace_id = s.workspace_id AND m.deleted_at IS NULL), true
FROM workspace_settings s
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE i.status = 'open')::int AS open,
    count(*) FILTER (WHERE i.status = 'done')::int AS done,
    count(*) FILTER (WHERE i.status = 'open' AND i.due_date < (now() AT TIME ZONE s.timezone)::date)::int AS overdue,
    count(*) FILTER (WHERE i.status = 'rejected')::int AS rejected
  FROM action_items i JOIN meeting_documents d ON d.id = i.document_id AND d.workspace_id = i.workspace_id AND d.is_current
  JOIN meetings m ON m.id = d.meeting_id AND m.workspace_id = d.workspace_id AND m.deleted_at IS NULL
  WHERE i.workspace_id = s.workspace_id AND i.deleted_at IS NULL
) a ON true
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE i.status = 'proposed')::int AS proposed,
    count(*) FILTER (WHERE i.status = 'confirmed')::int AS confirmed,
    count(*) FILTER (WHERE i.status = 'rejected')::int AS rejected
  FROM decisions i JOIN meeting_documents d ON d.id = i.document_id AND d.workspace_id = i.workspace_id AND d.is_current
  JOIN meetings m ON m.id = d.meeting_id AND m.workspace_id = d.workspace_id AND m.deleted_at IS NULL
  WHERE i.workspace_id = s.workspace_id AND i.deleted_at IS NULL
) c ON true;

--> statement-breakpoint
ALTER TABLE "item_status_events" ADD COLUMN "decision_id" uuid GENERATED ALWAYS AS (CASE WHEN item_type = 'decision' THEN item_id END) STORED;--> statement-breakpoint
ALTER TABLE "item_status_events" ADD COLUMN "action_item_id" uuid GENERATED ALWAYS AS (CASE WHEN item_type = 'action_item' THEN item_id END) STORED;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_workspace_key" UNIQUE("id","workspace_id");
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_workspace_key" UNIQUE("id","workspace_id");
--> statement-breakpoint
ALTER TABLE "item_status_events" ADD CONSTRAINT "item_status_events_decision_fk" FOREIGN KEY ("decision_id","workspace_id") REFERENCES "public"."decisions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_status_events" ADD CONSTRAINT "item_status_events_action_fk" FOREIGN KEY ("action_item_id","workspace_id") REFERENCES "public"."action_items"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
--> statement-breakpoint
CREATE INDEX "item_status_events_decision_idx" ON "item_status_events" USING btree ("decision_id","workspace_id");--> statement-breakpoint
CREATE INDEX "item_status_events_action_idx" ON "item_status_events" USING btree ("action_item_id","workspace_id");