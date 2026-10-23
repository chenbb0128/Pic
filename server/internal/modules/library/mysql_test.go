package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/pressly/goose/v3"
)

// Run only against the project's dedicated local test database, never production.
func TestMySQLLibraryPersistsAndUsesAtomicVersions(t *testing.T) {
	dsn := os.Getenv("PIC_TEST_DSN")
	if dsn == "" {
		t.Skip("PIC_TEST_DSN not set: MySQL integration not run")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err = goose.SetDialect("mysql"); err != nil {
		t.Fatal(err)
	}
	if err = goose.Up(db, "../../../database/migrations"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store := &MySQLStore{DB: db}
	id, _ := randomID(16)
	t.Cleanup(func() {
		db.Exec("DELETE FROM pic_document_assets WHERE document_id=?", id)
		db.Exec("DELETE FROM pic_documents WHERE id=?", id)
	})
	var bad Document
	// Coordinates must survive byte-for-byte: MySQL JSON normalization can move
	// a floating-point value across a ceil/floor boundary used by canvas masks.
	raw := json.RawMessage(`{"coordinate":1975.2229299363057,"width":195.66878980891718}`)
	bad = Document{ID: id, Kind: "project", Name: "测试", Snapshot: raw, UpdatedAt: time.Now().UTC()}
	if _, err = store.Save(ctx, bad, []string{"0123456789abcdef0123456789abcdef"}, 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing file accepted: %v", err)
	}
	created, err := store.Save(ctx, bad, nil, 0)
	if err != nil || created.Version != 1 {
		t.Fatal(created, err)
	}
	reopened := &MySQLStore{DB: db}
	doc, err := reopened.Get(ctx, "project", id)
	if err != nil || doc.Name != "测试" || len(doc.Snapshot) == 0 {
		t.Fatal(doc, err)
	}
	if string(doc.Snapshot) != string(raw) {
		t.Fatalf("snapshot precision changed: got %s want %s", doc.Snapshot, raw)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := store.Save(ctx, bad, nil, 1); results <- e }()
	}
	wg.Wait()
	close(results)
	ok, conflict := 0, 0
	for e := range results {
		if e == nil {
			ok++
		} else if errors.Is(e, ErrConflict) {
			conflict++
		} else {
			t.Fatal(e)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", ok, conflict)
	}
	if err = store.Delete(ctx, "project", id, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale deletion: %v", err)
	}
	if err = store.Delete(ctx, "project", id, 2); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Get(ctx, "project", id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted visible: %v", err)
	}
}

func TestMySQLLibrarySearchAndThumbnails(t *testing.T) {
	dsn := os.Getenv("PIC_TEST_DSN")
	if dsn == "" {
		t.Skip("PIC_TEST_DSN not set")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	goose.SetDialect("mysql")
	if err = goose.Up(db, "../../../database/migrations"); err != nil {
		t.Fatal(err)
	}
	store := &MySQLStore{DB: db}
	id, _ := randomID(16)
	assetID, _ := randomID(16)
	if err = store.CreateAsset(context.Background(), Asset{ID: assetID, MIME: "image/png", Width: 160, Height: 240, Size: 100}); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	t.Cleanup(func() {
		for _, key := range ids {
			db.Exec("DELETE FROM pic_document_assets WHERE document_id=?", key)
			db.Exec("DELETE FROM pic_documents WHERE id=?", key)
		}
		db.Exec("DELETE FROM pic_assets WHERE id=?", assetID)
	})
	h, err := NewHandler(store, Options{Username: "staff", Password: "test-password-only", SessionKey: "test-session-key-at-least-32-bytes", Origin: "http://localhost:5173", DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	cookie := login(t, h)
	base := strings.ReplaceAll(string(snapshot()), "0123456789abcdef0123456789abcdef", assetID)
	base = strings.Replace(base, `"dpi":600`, `"dpi":600,"footerText":"`+id+`-%_!订单"`, 1)
	for i := 0; i < 52; i++ {
		name := fmt.Sprintf("%s-普通-%d", id, i)
		if i == 0 {
			name = id + "-客户小王"
		}
		raw := string(snapshot())
		raw = strings.ReplaceAll(raw, "0123456789abcdef0123456789abcdef", assetID)
		if i == 0 {
			raw = base
		}
		body := fmt.Sprintf(`{"name":%q,"thumbnailId":%q,"snapshot":%s}`, name, assetID, raw)
		w := request(h, "POST", "/api/v1/projects", body, cookie)
		if w.Code != 201 {
			t.Fatalf("save thumbnail: %d %s", w.Code, w.Body)
		}
		var result struct{ Data Document }
		json.Unmarshal(w.Body.Bytes(), &result)
		ids = append(ids, result.Data.ID)
	}
	for _, query := range []string{"客户小王", id + "-%25_!", id + "-%25_!订单"} {
		w := request(h, "GET", "/api/v1/projects?q="+query, "", cookie)
		var result struct{ Data []map[string]any }
		json.Unmarshal(w.Body.Bytes(), &result)
		if w.Code != 200 || len(result.Data) != 1 || result.Data[0]["id"] != ids[0] {
			t.Fatalf("query %q: %d %s", query, w.Code, w.Body)
		}
		if result.Data[0]["thumbnailId"] != assetID || result.Data[0]["number"] != id+"-%_!订单" || result.Data[0]["snapshot"] != nil {
			t.Fatalf("list metadata: %s", w.Body)
		}
	}
	w := request(h, "GET", "/api/v1/projects?q="+id+"&offset=50", "", cookie)
	var page struct{ Data []Document }
	json.Unmarshal(w.Body.Bytes(), &page)
	if len(page.Data) != 2 {
		t.Fatalf("filtered pagination: %s", w.Body)
	}
	if w = request(h, "GET", "/api/v1/projects?q="+strings.Repeat("a", 201), "", cookie); w.Code != 400 {
		t.Fatalf("unbounded query: %d", w.Code)
	}
	missing := strings.Repeat("f", 32)
	w = request(h, "PUT", "/api/v1/projects/"+ids[0], fmt.Sprintf(`{"name":"bad","version":1,"thumbnailId":%q,"snapshot":%s}`, missing, base), cookie)
	if w.Code != 400 {
		t.Fatalf("missing thumbnail accepted: %d %s", w.Code, w.Body)
	}
	if w = request(h, "DELETE", "/api/v1/projects/"+ids[0], `{"version":1}`, cookie); w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = request(h, "GET", "/api/v1/projects?q=客户小王", "", cookie)
	json.Unmarshal(w.Body.Bytes(), &page)
	if len(page.Data) != 0 {
		t.Fatalf("deleted file in search: %s", w.Body)
	}
}

func TestMySQLLibraryResultImages(t *testing.T) {
	dsn := os.Getenv("PIC_TEST_DSN")
	if dsn == "" {
		t.Skip("PIC_TEST_DSN not set")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	goose.SetDialect("mysql")
	if err = goose.Up(db, "../../../database/migrations"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store := &MySQLStore{DB: db}
	imageID, _ := randomID(16)
	resultID, _ := randomID(16)
	jpegID, _ := randomID(16)
	for _, a := range []Asset{
		{ID: imageID, MIME: "image/png", Width: 200, Height: 200, Size: 100},
		{ID: resultID, MIME: "image/png", Width: 3402, Height: 5031, Size: 1000},
		{ID: jpegID, MIME: "image/jpeg", Width: 20, Height: 20, Size: 100},
	} {
		if err = store.CreateAsset(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	var docID string
	t.Cleanup(func() {
		if docID != "" {
			db.Exec("DELETE FROM pic_document_assets WHERE document_id=?", docID)
			db.Exec("DELETE FROM pic_documents WHERE id=?", docID)
		}
		for _, key := range []string{imageID, resultID, jpegID} {
			db.Exec("DELETE FROM pic_assets WHERE id=?", key)
		}
	})
	h, err := NewHandler(store, Options{Username: "staff", Password: "test-password-only", SessionKey: "test-session-key-at-least-32-bytes", Origin: "http://localhost:5173", DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	cookie := login(t, h)
	raw := strings.ReplaceAll(string(snapshot()), "0123456789abcdef0123456789abcdef", imageID)
	body := func(version int, result string) string {
		return fmt.Sprintf(`{"name":"可编辑作品","version":%d,"resultId":%q,"thumbnailId":%q,"snapshot":%s}`, version, result, imageID, raw)
	}
	w := request(h, "POST", "/api/v1/projects", body(0, resultID), cookie)
	if w.Code != 201 {
		t.Fatalf("save result: %d %s", w.Code, w.Body)
	}
	var response struct{ Data map[string]any }
	json.Unmarshal(w.Body.Bytes(), &response)
	docID = response.Data["id"].(string)
	if response.Data["resultId"] != resultID {
		t.Fatalf("missing result: %s", w.Body)
	}
	w = request(h, "GET", "/api/v1/projects/"+docID, "", cookie)
	json.Unmarshal(w.Body.Bytes(), &response)
	if w.Code != 200 || response.Data["resultId"] != resultID || response.Data["snapshot"] == nil {
		t.Fatalf("reopen result: %s", w.Body)
	}
	listed := request(h, "GET", "/api/v1/projects?q=可编辑作品", "", cookie)
	var listing struct{ Data []map[string]any }
	json.Unmarshal(listed.Body.Bytes(), &listing)
	found := false
	for _, d := range listing.Data {
		if d["id"] == docID {
			found = d["resultId"] == resultID && d["snapshot"] == nil
		}
	}
	if !found {
		t.Fatalf("list result: %s", listed.Body)
	}
	var refs int
	if err = db.QueryRow("SELECT COUNT(*) FROM pic_document_assets WHERE document_id=? AND asset_id=?", docID, resultID).Scan(&refs); err != nil || refs != 1 {
		t.Fatalf("result unreferenced: %d %v", refs, err)
	}
	for _, bad := range []string{"../bad", strings.Repeat("f", 32), jpegID} {
		w = request(h, "PUT", "/api/v1/projects/"+docID, body(1, bad), cookie)
		if w.Code != 400 {
			t.Fatalf("invalid result %q: %d %s", bad, w.Code, w.Body)
		}
	}
	// A successful update changes both snapshot and result, while a stale writer changes neither.
	w = request(h, "PUT", "/api/v1/projects/"+docID, body(1, imageID), cookie)
	if w.Code != 200 {
		t.Fatalf("update result: %d %s", w.Code, w.Body)
	}
	w = request(h, "PUT", "/api/v1/projects/"+docID, body(1, resultID), cookie)
	if w.Code != 409 {
		t.Fatalf("stale result update: %d %s", w.Code, w.Body)
	}
	w = request(h, "GET", "/api/v1/projects/"+docID, "", cookie)
	json.Unmarshal(w.Body.Bytes(), &response)
	if response.Data["resultId"] != imageID || response.Data["version"] != float64(2) {
		t.Fatalf("result overwritten: %s", w.Body)
	}
	// Legacy clients may save without a result, but must not leave a stale result attached.
	w = request(h, "PUT", "/api/v1/projects/"+docID, fmt.Sprintf(`{"name":"旧格式","version":2,"snapshot":%s}`, raw), cookie)
	if w.Code != 200 {
		t.Fatalf("legacy save: %d %s", w.Code, w.Body)
	}
	w = request(h, "GET", "/api/v1/projects/"+docID, "", cookie)
	response.Data = nil
	json.Unmarshal(w.Body.Bytes(), &response)
	if response.Data["resultId"] != nil {
		t.Fatalf("stale result retained: %s", w.Body)
	}
	// Templates must not accidentally retain a customer's composed result image.
	w = request(h, "POST", "/api/v1/templates", body(0, resultID), cookie)
	if w.Code != 400 {
		t.Fatalf("template accepts customer result: %d %s", w.Code, w.Body)
	}
}
