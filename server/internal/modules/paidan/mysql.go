package paidan

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/go-sql-driver/mysql"
)

type mysqlRepository struct {
	db *sql.DB
}

// OpenDatabase configures a pool for the database explicitly named in the paidan DSN.
func OpenDatabase(dsn string) (*sql.DB, error) {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil || cfg.DBName == "" {
		return nil, errors.New("paidan MySQL DSN must name an explicit database")
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	_ = cfg.Apply(mysql.Charset("utf8mb4", ""))
	cfg.Params["time_zone"] = "'+00:00'"
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, errors.New("invalid paidan MySQL connection configuration")
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)
	return db, nil
}

func (m mysqlRepository) createSession(ctx context.Context, device Device, candidate storedSession) (storedSession, error) {
	tx, err := m.beginWrite(ctx)
	if err != nil {
		return storedSession{}, err
	}
	defer tx.Rollback()

	inputData, err := json.Marshal(candidate.Input)
	if err != nil {
		return storedSession{}, err
	}
	// Both the request and asset IDs are reserved by the same unique-indexed row.
	_, err = tx.ExecContext(ctx, `INSERT INTO paidan_upload_sessions
        (workspace_id, session_id, device_id, request_id, asset_id, bucket, object_key, fingerprint, input_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE session_id = session_id`,
		device.Workspace, candidate.ID, device.ID, candidate.Input.RequestID, candidate.Input.AssetID,
		candidate.Bucket, candidate.Key, candidate.Fingerprint[:], string(inputData))
	if err != nil {
		return storedSession{}, err
	}
	row := tx.QueryRowContext(ctx, `SELECT session_id, bucket, object_key, fingerprint, input_data, result_version
        FROM paidan_upload_sessions WHERE workspace_id = ? AND device_id = ? AND request_id = ? FOR UPDATE`,
		device.Workspace, device.ID, candidate.Input.RequestID)
	session, err := scanSession(row)
	if errors.Is(err, errNotFound) || (err == nil && session.Fingerprint != candidate.Fingerprint) {
		return storedSession{}, errConflict
	}
	if err != nil {
		return storedSession{}, err
	}
	if session.Version == 0 {
		if err := checkUploadTarget(ctx, tx, device, session.Input); err != nil {
			return storedSession{}, err
		}
	}
	return session, tx.Commit()
}

func (m mysqlRepository) getSession(ctx context.Context, device Device, id string) (storedSession, error) {
	row := m.db.QueryRowContext(ctx, `SELECT session_id, bucket, object_key, fingerprint, input_data, result_version
        FROM paidan_upload_sessions WHERE workspace_id = ? AND device_id = ? AND session_id = ?`, device.Workspace, device.ID, id)
	return scanSession(row)
}

func scanSession(row *sql.Row) (storedSession, error) {
	var session storedSession
	var digest, input []byte
	if err := row.Scan(&session.ID, &session.Bucket, &session.Key, &digest, &input, &session.Version); err != nil {
		return storedSession{}, rowError(err)
	}
	if len(digest) != len(session.Fingerprint) {
		return storedSession{}, errors.New("invalid stored upload fingerprint")
	}
	copy(session.Fingerprint[:], digest)
	if err := json.Unmarshal(input, &session.Input); err != nil {
		return storedSession{}, err
	}
	return session, nil
}

func checkUploadTarget(ctx context.Context, tx *sql.Tx, device Device, input uploadInput) error {
	var deleted bool
	err := tx.QueryRowContext(ctx, `SELECT deleted FROM paidan_orders WHERE workspace_id = ? AND order_number = ?`,
		device.Workspace, input.OrderNumber).Scan(&deleted)
	if err == sql.ErrNoRows && input.Kind == kindOriginal {
		return nil
	}
	if err != nil {
		return rowError(err)
	}
	if deleted {
		return errConflict
	}
	return checkSourceImage(ctx, tx, device, input)
}

func checkSourceImage(ctx context.Context, tx *sql.Tx, device Device, input uploadInput) error {
	if input.SourceImageID == "" {
		return nil
	}
	var exists int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM paidan_assets WHERE workspace_id = ? AND order_number = ?
        AND asset_id = ? AND kind = ? AND NOT deleted`, device.Workspace, input.OrderNumber, input.SourceImageID, kindOriginal).Scan(&exists)
	return rowError(err)
}

var layoutNumberPattern = regexp.MustCompile(`^(ch|yy|x)-[a-zA-Z0-9]{1,64}$`)

func extractLayoutNumber(fields map[string]json.RawMessage) (string, time.Time) {
	var number, capturedAt string
	if err := json.Unmarshal(fields["layoutNumber"], &number); err != nil || !layoutNumberPattern.MatchString(number) {
		return "", time.Time{}
	}
	_ = json.Unmarshal(fields["layoutNumberCapturedAt"], &capturedAt)
	timestamp, _ := time.Parse(time.RFC3339Nano, capturedAt)
	return number, timestamp
}

// Keep the first upload's metadata and let later originals update its layout number.
func mergeOriginalMetadata(current, incoming string) string {
	if current == "" {
		return incoming
	}
	var updates map[string]json.RawMessage
	if err := json.Unmarshal([]byte(incoming), &updates); err != nil {
		return current
	}
	number, capturedAt := extractLayoutNumber(updates)
	if number == "" {
		return current
	}
	var existing map[string]json.RawMessage
	if err := json.Unmarshal([]byte(current), &existing); err != nil || existing == nil {
		legacy, _ := json.Marshal(current)
		existing = map[string]json.RawMessage{"legacyMetadata": legacy}
	}
	_, previousTimestamp := extractLayoutNumber(existing)
	if !previousTimestamp.IsZero() && !capturedAt.After(previousTimestamp) {
		return current
	}
	existing["layoutNumber"] = updates["layoutNumber"]
	if capturedAt.IsZero() {
		delete(existing, "layoutNumberCapturedAt")
	} else {
		existing["layoutNumberCapturedAt"] = updates["layoutNumberCapturedAt"]
	}
	merged, err := json.Marshal(existing)
	if err != nil {
		return current
	}
	return string(merged)
}

func (m mysqlRepository) completeSession(ctx context.Context, device Device, verified storedSession) (int64, error) {
	tx, err := m.beginWrite(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	row := tx.QueryRowContext(ctx, `SELECT session_id, bucket, object_key, fingerprint, input_data, result_version
        FROM paidan_upload_sessions WHERE workspace_id = ? AND device_id = ? AND session_id = ? FOR UPDATE`,
		device.Workspace, device.ID, verified.ID)
	session, err := scanSession(row)
	if err != nil {
		return 0, err
	}
	if session.Version > 0 {
		return session.Version, nil
	}
	if session.Fingerprint != verified.Fingerprint || session.Bucket != verified.Bucket || session.Key != verified.Key {
		return 0, errConflict
	}

	input := session.Input
	if input.Kind == kindOriginal {
		// The new order and its first asset are published in the same commit.
		_, err := tx.ExecContext(ctx, `INSERT INTO paidan_orders (workspace_id, order_number, metadata)
            VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE order_number = order_number`, device.Workspace, input.OrderNumber, input.Metadata)
		if err != nil {
			return 0, err
		}
	}
	version, deleted, metadata, err := lockOrder(ctx, tx, device.Workspace, input.OrderNumber)
	if err != nil {
		return 0, err
	}
	if deleted {
		return 0, errConflict
	}
	if err := checkSourceImage(ctx, tx, device, input); err != nil {
		return 0, err
	}
	templates, err := json.Marshal(input.Templates)
	if err != nil {
		return 0, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO paidan_assets
        (workspace_id, asset_id, order_number, bucket, object_key, kind, file_name, mime,
         byte_length, width, height, sha256, etag, templates, source_image_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		device.Workspace, input.AssetID, input.OrderNumber, session.Bucket, session.Key, input.Kind,
		input.FileName, input.MIME, input.ByteLength, input.Width, input.Height, input.SHA256,
		input.ETag, string(templates), input.SourceImageID)
	if err != nil {
		return 0, err
	}

	if input.Kind == kindOriginal {
		metadata = mergeOriginalMetadata(metadata, input.Metadata)
	}
	version++
	_, err = tx.ExecContext(ctx, `UPDATE paidan_orders SET version = ?, metadata = ?
        WHERE workspace_id = ? AND order_number = ?`, version, metadata, device.Workspace, input.OrderNumber)
	if err != nil {
		return 0, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE paidan_upload_sessions SET result_version = ?
        WHERE workspace_id = ? AND session_id = ?`, version, device.Workspace, session.ID)
	if err != nil {
		return 0, err
	}
	return version, tx.Commit()
}

func (m mysqlRepository) listOrders(ctx context.Context, device Device, after string, limit int) (orderList, error) {
	rows, err := m.db.QueryContext(ctx, `SELECT order_number, version, deleted FROM paidan_orders
        WHERE workspace_id = ? AND order_number > ? AND version > 0 ORDER BY order_number LIMIT ?`,
		device.Workspace, after, limit+1)
	if err != nil {
		return orderList{}, err
	}
	defer rows.Close()
	result := orderList{Orders: make([]orderSummary, 0, limit)}
	for rows.Next() {
		var item orderSummary
		if err := rows.Scan(&item.Number, &item.Version, &item.Deleted); err != nil {
			return orderList{}, err
		}
		if len(result.Orders) == limit {
			result.Next = &result.Orders[limit-1].Number
			break
		}
		result.Orders = append(result.Orders, item)
	}
	return result, rows.Err()
}

func (m mysqlRepository) getOrder(ctx context.Context, device Device, number string) (orderSnapshot, error) {
	tx, err := m.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return orderSnapshot{}, err
	}
	defer tx.Rollback()

	result := orderSnapshot{orderSummary: orderSummary{Number: number}, Assets: []asset{}}
	err = tx.QueryRowContext(ctx, `SELECT version, deleted, metadata FROM paidan_orders
        WHERE workspace_id = ? AND order_number = ? AND version > 0`, device.Workspace, number).
		Scan(&result.Version, &result.Deleted, &result.Metadata)
	if err != nil {
		return orderSnapshot{}, rowError(err)
	}
	if result.Deleted {
		return result, tx.Commit()
	}

	rows, err := tx.QueryContext(ctx, `SELECT asset_id, kind, file_name, mime, byte_length, width, height,
        sha256, etag, templates, source_image_id, created_at, deleted FROM paidan_assets
        WHERE workspace_id = ? AND order_number = ? ORDER BY created_at, asset_id`, device.Workspace, number)
	if err != nil {
		return orderSnapshot{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var a asset
		var rawTemplates []byte
		if err := rows.Scan(&a.ID, &a.Kind, &a.FileName, &a.MIME, &a.ByteLength, &a.Width, &a.Height,
			&a.SHA256, &a.ETag, &rawTemplates, &a.SourceImageID, &a.CreatedAt, &a.Deleted); err != nil {
			return orderSnapshot{}, err
		}
		if err := json.Unmarshal(rawTemplates, &a.Templates); err != nil {
			return orderSnapshot{}, err
		}
		result.Assets = append(result.Assets, a)
	}
	if err := rows.Err(); err != nil {
		return orderSnapshot{}, err
	}
	return result, tx.Commit()
}

func (m mysqlRepository) assetKey(ctx context.Context, device Device, id string) (string, string, error) {
	var bucket, key string
	err := m.db.QueryRowContext(ctx, `SELECT a.bucket, a.object_key FROM paidan_assets a JOIN paidan_orders o
        ON a.workspace_id = o.workspace_id AND a.order_number = o.order_number
        WHERE a.workspace_id = ? AND a.asset_id = ? AND NOT a.deleted AND NOT o.deleted AND o.version > 0`,
		device.Workspace, id).Scan(&bucket, &key)
	return bucket, key, rowError(err)
}

func (m mysqlRepository) mutate(ctx context.Context, device Device, input mutation) (int64, error) {
	tx, err := m.beginWrite(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	digest := fingerprint(struct {
		Payload     mutation
		Kind        string
		OrderNumber string
		AssetID     string
	}{input, input.Kind, input.OrderNumber, input.AssetID})
	_, err = tx.ExecContext(ctx, `INSERT INTO paidan_mutations (workspace_id, device_id, request_id, fingerprint)
        VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE request_id = request_id`, device.Workspace, device.ID, input.RequestID, digest[:])
	if err != nil {
		return 0, err
	}
	var existing []byte
	var appliedVersion int64
	err = tx.QueryRowContext(ctx, `SELECT fingerprint, result_version FROM paidan_mutations
        WHERE workspace_id = ? AND device_id = ? AND request_id = ? FOR UPDATE`,
		device.Workspace, device.ID, input.RequestID).Scan(&existing, &appliedVersion)
	if err != nil {
		return 0, err
	}
	if !bytes.Equal(existing, digest[:]) {
		return 0, errConflict
	}
	if appliedVersion > 0 {
		return appliedVersion, nil
	}

	version, deleted, _, err := lockOrder(ctx, tx, device.Workspace, input.OrderNumber)
	if err != nil {
		return 0, err
	}
	if version != input.ExpectedVersion {
		return 0, errStale
	}
	if deleted {
		return 0, errNotFound
	}
	if input.Kind != deleteOrder {
		if err := mutateImage(ctx, tx, device, input); err != nil {
			return 0, err
		}
	}
	version++
	_, err = tx.ExecContext(ctx, `UPDATE paidan_orders SET version = ?, deleted = ?
        WHERE workspace_id = ? AND order_number = ?`, version, input.Kind == deleteOrder, device.Workspace, input.OrderNumber)
	if err != nil {
		return 0, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE paidan_mutations SET result_version = ?
        WHERE workspace_id = ? AND device_id = ? AND request_id = ?`, version, device.Workspace, device.ID, input.RequestID)
	if err != nil {
		return 0, err
	}
	return version, tx.Commit()
}

func mutateImage(ctx context.Context, tx *sql.Tx, device Device, input mutation) error {
	// The caller holds the order row lock. Existence is checked separately so
	// setting templates to their current value still records the mutation.
	var exists int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM paidan_assets WHERE workspace_id = ? AND order_number = ?
        AND asset_id = ? AND kind = ? AND NOT deleted`, device.Workspace, input.OrderNumber, input.AssetID, kindOriginal).Scan(&exists)
	if err != nil {
		return rowError(err)
	}
	if input.Kind == deleteImage {
		_, err := tx.ExecContext(ctx, `UPDATE paidan_assets SET deleted = TRUE WHERE workspace_id = ? AND asset_id = ?`,
			device.Workspace, input.AssetID)
		return err
	}
	data, err := json.Marshal(input.Templates)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE paidan_assets SET templates = ? WHERE workspace_id = ? AND asset_id = ?`,
		string(data), device.Workspace, input.AssetID)
	return err
}

func (m mysqlRepository) beginWrite(ctx context.Context) (*sql.Tx, error) {
	return m.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
}

func lockOrder(ctx context.Context, tx *sql.Tx, workspace, number string) (int64, bool, string, error) {
	var version int64
	var deleted bool
	var metadata string
	err := tx.QueryRowContext(ctx, `SELECT version, deleted, metadata FROM paidan_orders
        WHERE workspace_id = ? AND order_number = ? FOR UPDATE`, workspace, number).Scan(&version, &deleted, &metadata)
	return version, deleted, metadata, rowError(err)
}

func rowError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return errNotFound
	}
	return err
}
