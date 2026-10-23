-- +goose Up
CREATE TABLE pic_sessions (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    credential_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    INDEX idx_pic_sessions_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE pic_assets (
    id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    mime VARCHAR(32) NOT NULL,
    size BIGINT NOT NULL,
    width INT NOT NULL,
    height INT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE pic_documents (
    id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    kind VARCHAR(16) NOT NULL,
    name VARCHAR(100) NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    snapshot JSON NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    deleted_at DATETIME(3) NULL,
    INDEX idx_pic_documents_list (kind, deleted_at, updated_at, id),
    CONSTRAINT chk_pic_document_kind CHECK (kind IN ('template', 'project'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE pic_document_assets (
    document_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (document_id, asset_id),
    FOREIGN KEY (document_id) REFERENCES pic_documents(id),
    FOREIGN KEY (asset_id) REFERENCES pic_assets(id)
) ENGINE=InnoDB;

-- +goose Down
DROP TABLE pic_document_assets;
DROP TABLE pic_documents;
DROP TABLE pic_assets;
DROP TABLE pic_sessions;
