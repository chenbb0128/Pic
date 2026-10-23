package library

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

type MySQLStore struct{ DB *sql.DB }

func dbError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
func (s *MySQLStore) SaveSession(ctx context.Context, key, credential string, expires time.Time) error {
	if _, err := s.DB.ExecContext(ctx, "DELETE FROM pic_sessions WHERE expires_at < UTC_TIMESTAMP(3) LIMIT 1000"); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx, "INSERT INTO pic_sessions(token_hash,credential_hash,expires_at) VALUES(?,?,?)", key, credential, expires.UTC())
	return err
}
func (s *MySQLStore) Session(ctx context.Context, key string) (Session, error) {
	var v Session
	err := s.DB.QueryRowContext(ctx, "SELECT credential_hash,expires_at FROM pic_sessions WHERE token_hash=?", key).Scan(&v.Credential, &v.Expires)
	return v, dbError(err)
}
func (s *MySQLStore) DeleteSession(ctx context.Context, key string) error {
	_, err := s.DB.ExecContext(ctx, "DELETE FROM pic_sessions WHERE token_hash=?", key)
	return err
}
func (s *MySQLStore) CreateAsset(ctx context.Context, a Asset) error {
	_, err := s.DB.ExecContext(ctx, "INSERT INTO pic_assets(id,mime,size,width,height) VALUES(?,?,?,?,?)", a.ID, a.MIME, a.Size, a.Width, a.Height)
	return err
}
func (s *MySQLStore) Asset(ctx context.Context, id string) (Asset, error) {
	var a Asset
	err := s.DB.QueryRowContext(ctx, "SELECT id,mime,size,width,height FROM pic_assets WHERE id=?", id).Scan(&a.ID, &a.MIME, &a.Size, &a.Width, &a.Height)
	return a, dbError(err)
}
func (s *MySQLStore) List(ctx context.Context, kind string, offset int, query string) ([]Document, error) {
	statement := "SELECT id,kind,name,footer_number,COALESCE(thumbnail_id,''),COALESCE(result_id,''),version,updated_at FROM pic_documents WHERE kind=? AND deleted_at IS NULL"
	args := []any{kind}
	if query != "" {
		pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(query) + "%"
		statement += " AND (name LIKE ? ESCAPE '!' OR footer_number LIKE ? ESCAPE '!')"
		args = append(args, pattern, pattern)
	}
	statement += " ORDER BY updated_at DESC,id DESC LIMIT 50 OFFSET ?"
	args = append(args, offset)
	rows, err := s.DB.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	docs := []Document{}
	for rows.Next() {
		var d Document
		if err := rows.Scan(&d.ID, &d.Kind, &d.Name, &d.Number, &d.ThumbnailID, &d.ResultID, &d.Version, &d.UpdatedAt); err != nil {
			return nil, err
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
}
func (s *MySQLStore) Get(ctx context.Context, kind, id string) (Document, error) {
	var d Document
	err := s.DB.QueryRowContext(ctx, "SELECT id,kind,name,footer_number,COALESCE(thumbnail_id,''),COALESCE(result_id,''),version,snapshot,updated_at FROM pic_documents WHERE id=? AND kind=? AND deleted_at IS NULL", id, kind).Scan(&d.ID, &d.Kind, &d.Name, &d.Number, &d.ThumbnailID, &d.ResultID, &d.Version, &d.Snapshot, &d.UpdatedAt)
	return d, dbError(err)
}
func (s *MySQLStore) Save(ctx context.Context, d Document, refs []string, version int64) (Document, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return d, err
	}
	defer tx.Rollback()
	for _, id := range refs {
		var exists int
		err = tx.QueryRowContext(ctx, "SELECT 1 FROM pic_assets WHERE id=?", id).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return d, ErrInvalid
		}
		if err != nil {
			return d, err
		}
	}
	d.Version = version + 1
	d.UpdatedAt = time.Now().UTC()
	if version == 0 {
		_, err = tx.ExecContext(ctx, "INSERT INTO pic_documents(id,kind,name,version,snapshot,updated_at,footer_number,thumbnail_id,result_id) VALUES(?,?,?,?,?,?,?,NULLIF(?,''),NULLIF(?,''))", d.ID, d.Kind, d.Name, d.Version, []byte(d.Snapshot), d.UpdatedAt, d.Number, d.ThumbnailID, d.ResultID)
	} else {
		var result sql.Result
		result, err = tx.ExecContext(ctx, "UPDATE pic_documents SET name=?,version=version+1,snapshot=?,updated_at=?,footer_number=?,thumbnail_id=NULLIF(?,''),result_id=NULLIF(?,'') WHERE id=? AND kind=? AND version=? AND deleted_at IS NULL", d.Name, []byte(d.Snapshot), d.UpdatedAt, d.Number, d.ThumbnailID, d.ResultID, d.ID, d.Kind, version)
		if err == nil {
			var count int64
			count, err = result.RowsAffected()
			if err == nil && count == 0 {
				return d, ErrConflict
			}
		}
	}
	if err != nil {
		return d, err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM pic_document_assets WHERE document_id=?", d.ID); err != nil {
		return d, err
	}
	for _, id := range refs {
		if _, err = tx.ExecContext(ctx, "INSERT INTO pic_document_assets(document_id,asset_id) VALUES(?,?)", d.ID, id); err != nil {
			return d, err
		}
	}
	return d, tx.Commit()
}
func (s *MySQLStore) Delete(ctx context.Context, kind, id string, version int64) error {
	result, err := s.DB.ExecContext(ctx, "UPDATE pic_documents SET deleted_at=UTC_TIMESTAMP(3),version=version+1 WHERE id=? AND kind=? AND version=? AND deleted_at IS NULL", id, kind, version)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return ErrConflict
	}
	return err
}
