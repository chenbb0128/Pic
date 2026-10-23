-- +goose Up
-- Preserve the editor's exact numeric JSON representation. MySQL's binary JSON
-- serialization can change subpixel coordinates during a read/write round trip.
ALTER TABLE pic_documents MODIFY snapshot LONGTEXT CHARACTER SET utf8mb4 NOT NULL;
ALTER TABLE pic_documents ADD CONSTRAINT chk_pic_snapshot_json CHECK (JSON_VALID(snapshot));

-- +goose Down
ALTER TABLE pic_documents DROP CHECK chk_pic_snapshot_json;
ALTER TABLE pic_documents MODIFY snapshot JSON NOT NULL;
