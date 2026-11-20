-- +goose Up
CREATE TABLE IF NOT EXISTS paidan_orders (
    workspace_id VARBINARY(64) NOT NULL,
    order_number VARBINARY(191) NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    metadata TEXT NOT NULL,
    PRIMARY KEY (workspace_id, order_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paidan_upload_sessions (
    workspace_id VARBINARY(64) NOT NULL,
    session_id VARBINARY(32) NOT NULL,
    device_id VARBINARY(64) NOT NULL,
    request_id VARBINARY(32) NOT NULL,
    asset_id VARBINARY(32) NOT NULL,
    bucket VARBINARY(63) NOT NULL,
    object_key VARBINARY(255) NOT NULL,
    fingerprint BINARY(32) NOT NULL,
    input_data JSON NOT NULL,
    result_version BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, session_id),
    UNIQUE KEY paidan_session_request (workspace_id, device_id, request_id),
    UNIQUE KEY paidan_session_asset (workspace_id, asset_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paidan_assets (
    workspace_id VARBINARY(64) NOT NULL,
    asset_id VARBINARY(32) NOT NULL,
    order_number VARBINARY(191) NOT NULL,
    bucket VARBINARY(63) NOT NULL,
    object_key VARBINARY(255) NOT NULL,
    kind VARBINARY(16) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    mime VARBINARY(32) NOT NULL,
    byte_length BIGINT NOT NULL,
    width INT NOT NULL,
    height INT NOT NULL,
    sha256 VARBINARY(64) NOT NULL,
    etag VARBINARY(28) NOT NULL,
    templates JSON NOT NULL,
    source_image_id VARBINARY(32) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (workspace_id, asset_id),
    KEY paidan_assets_order (workspace_id, order_number, created_at, asset_id),
    CONSTRAINT paidan_assets_order_fk FOREIGN KEY (workspace_id, order_number)
        REFERENCES paidan_orders (workspace_id, order_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paidan_mutations (
    workspace_id VARBINARY(64) NOT NULL,
    device_id VARBINARY(64) NOT NULL,
    request_id VARBINARY(32) NOT NULL,
    fingerprint BINARY(32) NOT NULL,
    result_version BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, device_id, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +goose Down
DROP TABLE IF EXISTS paidan_mutations;
DROP TABLE IF EXISTS paidan_assets;
DROP TABLE IF EXISTS paidan_upload_sessions;
DROP TABLE IF EXISTS paidan_orders;

