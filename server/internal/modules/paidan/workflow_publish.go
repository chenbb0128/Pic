package paidan

import (
	"context"
	"database/sql"
	"errors"
	"sort"
)

// The head serializes revisions. The operation receipt, visible blob references,
// and new head all become readable in the same transaction.
func (api workflowAPI) publish(ctx context.Context, d Device, collection, id string, expected int64, data []byte, m workflowManifest) error {
	digest := workflowDigest(data)
	tx, err := api.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	head := []any{d.Workspace, api.bucket, collection, id}
	_, err = tx.ExecContext(ctx, "INSERT INTO paidan_workflow_heads(workspace_id,bucket,collection,item_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE item_id=VALUES(item_id)", head...)
	if err != nil {
		return err
	}
	var current int64
	var state, previous string
	err = tx.QueryRowContext(ctx, "SELECT revision,state,digest FROM paidan_workflow_heads WHERE workspace_id=? AND bucket=? AND collection=? AND item_id=? FOR UPDATE", head...).Scan(&current, &state, &previous)
	if err != nil {
		return err
	}
	if collection == "backups" {
		if previous != "" {
			if previous == digest {
				return nil
			}
			return errConflict
		}
	} else {
		var receipt string
		err = tx.QueryRowContext(ctx, "SELECT digest FROM paidan_workflow_operations WHERE workspace_id=? AND bucket=? AND item_id=? AND operation_id=?", d.Workspace, api.bucket, id, m.Operation).Scan(&receipt)
		if err == nil {
			if receipt != digest {
				return errConflict
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if current != expected {
			return errStale
		}
		if state == "completed" || (m.State == "completed" && state != "pending") {
			return errConflict
		}
	}

	sizes := map[string]int64{digest: int64(len(data))}
	for _, a := range m.Assets {
		if prior, ok := sizes[a.SHA]; ok && prior != a.Size {
			return errUploadMismatch
		}
		sizes[a.SHA] = a.Size
	}
	keys := make([]string, 0, len(sizes))
	for key := range sizes {
		keys = append(keys, key)
	}
	sort.Strings(keys) // Different orders can publish the same blobs concurrently.
	for _, key := range keys {
		var blob workflowBlob
		err = tx.QueryRowContext(ctx, "SELECT byte_length,etag FROM paidan_workflow_blobs WHERE workspace_id=? AND bucket=? AND digest=? FOR UPDATE", d.Workspace, api.bucket, key).Scan(&blob.Size, &blob.ETag)
		if errors.Is(err, sql.ErrNoRows) {
			return errObjectMissing
		}
		if err != nil {
			return err
		}
		if blob.Size != sizes[key] || (key == digest && blob.ETag != manifestETag(data)) {
			return errUploadMismatch
		}
		_, err = tx.ExecContext(ctx, "UPDATE paidan_workflow_blobs SET published=TRUE WHERE workspace_id=? AND bucket=? AND digest=?", d.Workspace, api.bucket, key)
		if err != nil {
			return err
		}
	}
	if collection == "orders" {
		_, err = tx.ExecContext(ctx, "INSERT INTO paidan_workflow_operations(workspace_id,bucket,item_id,operation_id,digest) VALUES(?,?,?,?,?)", d.Workspace, api.bucket, id, m.Operation, digest)
		if err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "UPDATE paidan_workflow_heads SET revision=?,state=?,digest=? WHERE workspace_id=? AND bucket=? AND collection=? AND item_id=?", m.Revision, m.State, digest, d.Workspace, api.bucket, collection, id)
	if err != nil {
		return err
	}
	return tx.Commit()
}
