package paidan

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestWorkflowManifestAndRoleValidation(t *testing.T) {
	for _, tc := range []struct {
		name, role, state  string
		revision, expected int64
		status             int
	}{
		{"production cannot publish originals", roleProduction, "pending", 1, 0, 403},
		{"customer cannot finalize", roleCustomer, "completed", 2, 1, 403},
		{"revision mismatch", roleBoth, "pending", 2, 0, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			name, local := "photo", false
			kind := kindOriginal
			if tc.state == "completed" {
				kind = kindProduction
			}
			input := workflowManifest{UpdatedAt: "now", LocalCompleted: &local, Assets: []workflowAsset{{ID: originalID, Name: &name, Kind: kind, SHA: testSHA, Size: 1}}, Schema: 1, Order: "A", Operation: requestID, State: tc.state, Revision: tc.revision}
			data, _ := json.Marshal(input)
			req := httptest.NewRequest("PUT", "/?expected=0", strings.NewReader(string(data)))
			if tc.expected == 1 {
				req.URL.RawQuery = "expected=1"
			}
			req.SetPathValue("id", workflowDigest([]byte("A")))
			rr := httptest.NewRecorder()
			(workflowAPI{}).commit("orders")(rr, req, testDevice(tc.role))
			if rr.Code != tc.status {
				t.Fatalf("got %d: %s", rr.Code, rr.Body.String())
			}
		})
	}
	if got := manifestETag([]byte("etag")); got != "FpLiADEaVoALPkdb8tJEJyRTXoe_" {
		t.Fatalf("ETag = %s", got)
	}
}

func TestWorkflowMySQLAtomicPublication(t *testing.T) {
	dsn := os.Getenv("PAIDAN_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("PAIDAN_TEST_MYSQL_DSN is unset")
	}
	db, err := OpenDatabase(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ws, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	defer func() {
		for _, table := range []string{"paidan_workflow_operations", "paidan_workflow_heads", "paidan_workflow_blobs"} {
			if _, err := db.Exec("DELETE FROM "+table+" WHERE workspace_id=?", ws); err != nil {
				t.Error(err)
			}
		}
	}()
	api := workflowAPI{handler: handler{bucket: "test"}, db: db}
	device := Device{Workspace: ws, Role: roleBoth}
	stage := func(data []byte) string {
		t.Helper()
		key := workflowDigest(data)
		_, err := db.Exec("INSERT INTO paidan_workflow_blobs(workspace_id,bucket,digest,byte_length,etag) VALUES (?,?,?,?,?)", ws, "test", key, len(data), manifestETag(data))
		if err != nil {
			t.Fatal(err)
		}
		return key
	}
	asset := []byte("picture")
	m := workflowManifest{Schema: 1, Order: "A", Operation: requestID, State: "pending", Revision: 1, Assets: []workflowAsset{{SHA: workflowDigest(asset), Size: int64(len(asset)), Kind: kindOriginal}}}
	order := workflowDigest([]byte("A"))
	manifest := func() []byte {
		data, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		stage(data)
		return data
	}
	first := manifest()
	publish := func(group, key string, expected int64, data []byte) error {
		return api.publish(ctx, device, group, key, expected, data, m)
	}
	if err := publish("orders", order, 0, first); !errors.Is(err, errObjectMissing) {
		t.Fatalf("missing asset: %v", err)
	}
	var visible int
	if err := db.QueryRow("SELECT COUNT(*) FROM paidan_workflow_blobs WHERE workspace_id=? AND published", ws).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("partial publication: %d %v", visible, err)
	}
	stage(asset)
	if err := publish("orders", order, 0, first); err != nil {
		t.Fatal(err)
	}
	m.State = "completed"
	m.Revision = 2
	m.Operation = originalID
	second := manifest()
	if err := publish("orders", order, 0, second); !errors.Is(err, errStale) {
		t.Fatalf("stale: %v", err)
	}
	if err := publish("orders", order, 1, second); err != nil {
		t.Fatal(err)
	}
	m.Operation = requestID
	if err := publish("orders", order, 0, first); err != nil {
		t.Fatalf("replay after completion: %v", err)
	}
	m.Operation = "11111111111111111111111111111111"
	m.State = "pending"
	m.Revision = 3
	third := manifest()
	if err := publish("orders", order, 2, third); !errors.Is(err, errConflict) {
		t.Fatalf("terminal head: %v", err)
	}
	m.Revision = 0
	backup := manifest()
	if err := publish("backups", requestID, 0, backup); err != nil {
		t.Fatal(err)
	}
	if err := publish("backups", requestID, 0, backup); err != nil {
		t.Fatalf("backup replay: %v", err)
	}
	if err := publish("backups", requestID, 0, third); !errors.Is(err, errConflict) {
		t.Fatalf("overwritten backup: %v", err)
	}
}
