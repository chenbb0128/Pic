-- +goose Up
ALTER TABLE pic_documents
    ADD COLUMN footer_number VARCHAR(200) NOT NULL DEFAULT '',
    ADD COLUMN thumbnail_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT fk_pic_thumbnail FOREIGN KEY (thumbnail_id) REFERENCES pic_assets(id);
UPDATE pic_documents SET footer_number = LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.settings.footerText')),''),200);

-- +goose Down
ALTER TABLE pic_documents DROP FOREIGN KEY fk_pic_thumbnail, DROP COLUMN thumbnail_id, DROP COLUMN footer_number;
