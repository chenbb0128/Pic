package vagaga

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const databaseTimeout = 3 * time.Second

// FromEnvironment opens the optional paidan module with an explicit database.
func FromEnvironment() (http.Handler, *sql.DB, error) {
	raw := env("PAIDAN_ENABLED")
	if raw == "" {
		return nil, nil, nil
	}
	enabled, err := strconv.ParseBool(raw)
	if err != nil {
		return nil, nil, errors.New("PAIDAN_ENABLED must be true or false")
	}
	if !enabled {
		return nil, nil, nil
	}
	dsn := env("PAIDAN_MYSQL_DSN")
	if dsn == "" {
		return nil, nil, errors.New("PAIDAN_MYSQL_DSN is required to enable paidan sync")
	}
	maxBytes := int64(defaultFileLimit)
	if raw := env("PAIDAN_MAX_FILE_BYTES"); raw != "" {
		var err error
		maxBytes, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || maxBytes <= 0 {
			return nil, nil, errors.New("PAIDAN_MAX_FILE_BYTES must be a positive integer")
		}
	}
	devices, err := parseDevices(env("PAIDAN_DEVICES_JSON"))
	if err != nil {
		return nil, nil, err
	}
	bucket := env("PAIDAN_QINIU_BUCKET")
	objects, err := newQiniuStore(env("PAIDAN_QINIU_ACCESS_KEY"), env("PAIDAN_QINIU_SECRET_KEY"), bucket,
		env("PAIDAN_QINIU_UPLOAD_URL"), env("PAIDAN_QINIU_DOWNLOAD_URL"))
	if err != nil {
		return nil, nil, err
	}
	db, err := OpenDatabase(dsn)
	if err != nil {
		return nil, nil, err
	}
	return newHandler(devices, mysqlRepository{db}, objects, maxBytes, bucket), db, nil
}

func (m mysqlRepository) ready(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, databaseTimeout)
	defer cancel()
	if err := m.db.PingContext(ctx); err != nil {
		return errors.New("paidan MySQL connection failed")
	}
	// Check for the migration without reading synchronization data.
	rows, err := m.db.QueryContext(ctx, "SELECT result_version FROM paidan_mutations LIMIT 0")
	if err != nil {
		return errors.New("paidan MySQL schema is not ready")
	}
	if err := rows.Close(); err != nil {
		return errors.New("paidan MySQL schema check failed")
	}
	return nil
}

func env(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}
