package app

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chenbb0128/Pic/server/internal/config"
)

func TestPaidanConfigurationFailureLeavesMainReadinessAvailable(t *testing.T) {
	t.Setenv("PIC_LIBRARY_ENABLED", "false")
	t.Setenv("PAIDAN_ENABLED", "true")
	t.Setenv("PAIDAN_MYSQL_DSN", "")
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	api, err := NewAPI(config.Config{HTTP: config.HTTPConfig{MaxBodyBytes: 1024}}, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = api.close() })
	request := func(path string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		api.server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		return response
	}
	if response := request("/ready"); response.Code != http.StatusOK {
		t.Fatalf("main readiness became unavailable: %s", response.Body)
	}
	response := request("/api/v1/paidan/device")
	var message map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &message); err != nil ||
		response.Code != http.StatusServiceUnavailable || message["code"] != "paidan_unavailable" {
		t.Fatalf("expected paidan unavailable error, got %d %s", response.Code, response.Body)
	}
	if !strings.Contains(logs.String(), "PAIDAN_MYSQL_DSN is required") {
		t.Fatal("missing paidan configuration diagnostic")
	}
}
