-- Couple document publication and review edits to the transactional outbox.
CREATE OR REPLACE FUNCTION mark_meeting_pdf_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid uuid; wid uuid;
BEGIN
  IF TG_TABLE_NAME = 'meeting_documents' THEN
    mid := NEW.meeting_id; wid := NEW.workspace_id;
    IF NOT NEW.is_current THEN RETURN NEW; END IF;
  ELSE
    SELECT meeting_id, workspace_id INTO mid, wid FROM meeting_documents WHERE id = NEW.document_id;
  END IF;
  UPDATE meetings SET pdf_dirty_at = clock_timestamp() WHERE id = mid AND workspace_id = wid;
  INSERT INTO domain_events (type, payload)
    SELECT 'document.pdf_requested', jsonb_build_object('workspaceId', wid, 'meetingId', mid)
    WHERE NOT EXISTS (
      SELECT 1 FROM domain_events WHERE type = 'document.pdf_requested' AND processed_at IS NULL
      AND payload->>'workspaceId' = wid::text AND payload->>'meetingId' = mid::text
    );
  RETURN NEW;
END $$;
