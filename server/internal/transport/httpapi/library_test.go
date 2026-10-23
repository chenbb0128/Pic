package httpapi_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chenbb0128/Pic/server/internal/config"
	"github.com/chenbb0128/Pic/server/internal/transport/httpapi"
)

func TestLibraryMountPreservesPathAndUploadBody(t *testing.T) {
	var gotPath string
	var size int
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		size = len(data)
		w.WriteHeader(201)
	})
	router, err := httpapi.NewRouter(httpapi.RouterOptions{Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), App: config.AppConfig{Name: "pic"}, HTTP: config.HTTPConfig{MaxBodyBytes: 28 << 20}, LibraryHandler: api})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/v1/assets", strings.NewReader(strings.Repeat("a", 2<<20)))
	router.ServeHTTP(w, r)
	if w.Code != 201 || size != 2<<20 || gotPath != "/api/v1/assets" {
		t.Fatal(w.Code, size, gotPath)
	}
}
