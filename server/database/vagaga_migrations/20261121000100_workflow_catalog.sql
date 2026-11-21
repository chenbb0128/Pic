-- +goose Up
CREATE TABLE paidan_workflow_blobs (
    workspace_id VARBINARY(64) NOT NULL,
    bucket VARBINARY(63) NOT NULL,
    digest VARBINARY(64) NOT NULL,
    byte_length BIGINT NOT NULL,
    etag VARBINARY(28) NOT NULL,
    published BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (workspace_id, bucket, digest)
) ENGINE=InnoDB;

CREATE TABLE paidan_workflow_heads (
    workspace_id VARBINARY(64) NOT NULL,
    bucket VARBINARY(63) NOT NULL,
    collection VARBINARY(8) NOT NULL,
    item_id VARBINARY(64) NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    state VARBINARY(10) NOT NULL DEFAULT '',
    digest VARBINARY(64) NOT NULL DEFAULT '',
    PRIMARY KEY (workspace_id, bucket, collection, item_id)
) ENGINE=InnoDB;

CREATE TABLE paidan_workflow_operations (
    workspace_id VARBINARY(64) NOT NULL,
    bucket VARBINARY(63) NOT NULL,
    item_id VARBINARY(64) NOT NULL,
    operation_id VARBINARY(32) NOT NULL,
    digest VARBINARY(64) NOT NULL,
    PRIMARY KEY (workspace_id, bucket, item_id, operation_id)
) ENGINE=InnoDB;

-- +goose Down
DROP TABLE paidan_workflow_operations;
DROP TABLE paidan_workflow_heads;
DROP TABLE paidan_workflow_blobs;
