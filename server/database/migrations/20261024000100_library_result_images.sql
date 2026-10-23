-- +goose Up
ALTER TABLE pic_documents
    ADD COLUMN result_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT fk_pic_result FOREIGN KEY (result_id) REFERENCES pic_assets(id);

-- +goose Down
ALTER TABLE pic_documents DROP FOREIGN KEY fk_pic_result, DROP COLUMN result_id;
