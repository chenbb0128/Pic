package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestContainerHealthcheck(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusServiceUnavailable, http.StatusFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/ready" {
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
				w.Header().Set("Location", "/ready")
				w.WriteHeader(status)
			}))
			defer server.Close()
			err := checkReady(server.URL + "/ready")
			if (err == nil) != (status == http.StatusOK) {
				t.Fatalf("status=%d: error=%v", status, err)
			}
		})
	}
}

func TestContainerHealthcheckUnreachable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	server.Close()
	if err := checkReady(server.URL + "/ready"); err == nil {
		t.Fatal("unreachable API must not be healthy")
	}
}
