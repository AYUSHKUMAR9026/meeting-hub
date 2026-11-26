-- Repair databases that already applied migration 0009 before alias normalization was added.
UPDATE workspace_settings SET timezone = 'Asia/Kolkata' WHERE timezone = 'Asia/Calcutta';
