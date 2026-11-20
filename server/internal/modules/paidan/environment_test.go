package paidan

import (
	"testing"
)

func TestEnvironmentIsOffByDefaultAndRequiresDedicatedDSN(t *testing.T) {
	t.Setenv("PAIDAN_ENABLED", "")
	t.Setenv("PAIDAN_MYSQL_DSN", "")
	handler, db, err := FromEnvironment()
	if err != nil || handler != nil || db != nil {
		t.Fatal("paidan must be disabled by default")
	}
	t.Setenv("PAIDAN_ENABLED", "true")
	if _, _, err := FromEnvironment(); err == nil {
		t.Fatal("paidan accepted a missing dedicated DSN")
	}
}
