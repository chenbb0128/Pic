package database

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/chenbb0128/Pic/server/internal/config"
)

func TestNormalizedDSNConnectsToMySQL(t *testing.T) {
	dsn := os.Getenv("PIC_TEST_DSN")
	if dsn == "" {
		t.Skip("PIC_TEST_DSN not set")
	}
	db, err := Open(context.Background(), config.DatabaseConfig{Driver: "mysql", DSN: dsn, PingTimeout: 5 * time.Second, MaxOpenConns: 2, MaxIdleConns: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var zone string
	if err = db.SQL.QueryRow("SELECT @@session.time_zone").Scan(&zone); err != nil || zone != "+00:00" {
		t.Fatal(zone, err)
	}
}
