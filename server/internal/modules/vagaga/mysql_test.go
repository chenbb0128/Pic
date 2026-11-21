package vagaga

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"testing"
)

func TestMergeOriginalMetadata(t *testing.T) {
	const first = `{"amount":"21.00","layoutNumber":"ch-00123","layoutNumberCapturedAt":"2026-11-20T03:00:00.010Z"}`
	const newest = `{"amount":"99.00","layoutNumber":"yy-00034","layoutNumberCapturedAt":"2026-11-20T03:00:00.099Z"}`
	const merged = `{"amount":"21.00","layoutNumber":"yy-00034","layoutNumberCapturedAt":"2026-11-20T03:00:00.099Z"}`
	for _, tc := range []struct{ name, current, incoming, want string }{
		{"first opaque upload", "", "客户备注", "客户备注"},
		{"later opaque upload", "客户备注", "另一条备注", "客户备注"},
		{"opaque metadata receives layout number", "客户备注", first, `{"layoutNumber":"ch-00123","layoutNumberCapturedAt":"2026-11-20T03:00:00.010Z","legacyMetadata":"客户备注"}`},
		{"new number preserves other fields", first, newest, merged},
		{"late completion of older upload", merged, first, merged},
		{"capture without layout number", first, `{"amount":"40.00"}`, first},
		{"invalid incoming number", first, `{"layoutNumber":"invalid","layoutNumberCapturedAt":"2026-11-20T04:00:00Z"}`, first},
		{"unstamped upload cannot replace a newer number", first, `{"layoutNumber":"x-008"}`, first},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := mergeOriginalMetadata(tc.current, tc.incoming); got != tc.want {
				t.Fatalf("metadata = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMySQLPublicationAndRevisionRetries(t *testing.T) {
	// Only runs against a dedicated test schema with the paidan migration applied.
	dsn := os.Getenv("PAIDAN_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("PAIDAN_TEST_MYSQL_DSN is unset")
	}
	db, err := OpenDatabase(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := mysqlRepository{db}
	ctx := context.Background()
	workspace, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	d := testDevice(roleBoth)
	d.Workspace = workspace
	t.Cleanup(func() {
		cleanupDB, err := OpenDatabase(dsn)
		if err != nil {
			t.Error(err)
			return
		}
		defer cleanupDB.Close()
		for _, table := range []string{"paidan_mutations", "paidan_assets", "paidan_upload_sessions", "paidan_orders"} {
			if _, err := cleanupDB.ExecContext(ctx, "DELETE FROM "+table+" WHERE workspace_id = ?", workspace); err != nil {
				t.Errorf("clean up %s: %v", table, err)
			}
		}
	})

	var in uploadInput
	if err := json.Unmarshal([]byte(validUploadJSON("订单A")), &in); err != nil {
		t.Fatal(err)
	}
	session := storedSession{ID: "0123456789aabbcc0123456789aabbcc", Key: "unit-original", Bucket: "test", Input: in, Fingerprint: fingerprint(in)}
	if _, err := repo.createSession(ctx, d, session); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.getOrder(ctx, d, in.OrderNumber); !errors.Is(err, errNotFound) {
		t.Fatalf("pending session exposed an order: %v", err)
	}
	if _, _, err := repo.assetKey(ctx, d, in.AssetID); !errors.Is(err, errNotFound) {
		t.Fatalf("pending session exposed an asset: %v", err)
	}
	deletePending := mutation{Kind: deleteOrder, OrderNumber: in.OrderNumber, ExpectedVersion: 1, RequestID: "99999999999999999999999999999999"}
	if _, err := repo.mutate(ctx, d, deletePending); !errors.Is(err, errNotFound) {
		t.Fatalf("unexpected pending deletion result: %v", err)
	}
	other := d
	other.Workspace = "no-access"
	customer := d
	customer.Role = roleCustomer
	production := d
	production.ID = "another-device"
	production.Role = roleProduction
	const customerToken = "test-customer-token"
	const productionToken = "test-production-token"
	const otherToken = "test-other-workspace-token"
	devices := authDevices{
		sha256.Sum256([]byte(customerToken)):   customer,
		sha256.Sum256([]byte(productionToken)): production,
		sha256.Sum256([]byte(otherToken)):      other,
	}
	objects := &fakeObjectStore{object: objectInfo{Size: in.ByteLength, ETag: in.ETag}}
	handler := newHandler(devices, repo, objects, defaultFileLimit, session.Bucket)
	orderPath := "/orders/" + url.PathEscape(in.OrderNumber)
	assetPath := "/assets/" + in.AssetID + "/download-url"
	apiRequest(t, handler, "GET", "/device", customerToken, "", 200)
	apiRequest(t, handler, "GET", orderPath, productionToken, "", 404)
	completePath := "/upload-sessions/" + session.ID + "/complete"
	apiRequest(t, handler, "POST", completePath, productionToken, "", 404)
	if result := apiRequest(t, handler, "POST", completePath, customerToken, "", 200); result["version"] != float64(1) {
		t.Fatalf("first publication returned the wrong version: %+v", result)
	}
	if result := apiRequest(t, handler, "GET", orderPath, productionToken, "", 200); result["orderNumber"] != in.OrderNumber ||
		len(result["assets"].([]any)) != 1 || result["metadata"] != in.Metadata {
		t.Fatalf("unexpected order visible to production device: %+v", result)
	}
	apiRequest(t, handler, "POST", assetPath, productionToken, "", 200)
	apiRequest(t, handler, "GET", orderPath, otherToken, "", 404)
	apiRequest(t, handler, "POST", assetPath, otherToken, "", 404)
	if _, err := repo.getSession(ctx, other, session.ID); !errors.Is(err, errNotFound) {
		t.Fatalf("other workspace can access session: %v", err)
	}
	if _, _, err := repo.assetKey(ctx, other, in.AssetID); !errors.Is(err, errNotFound) {
		t.Fatalf("other workspace can access asset: %v", err)
	}
	copyDevice := d
	copyDevice.ID = "another-device"
	if _, err := repo.getSession(ctx, copyDevice, session.ID); !errors.Is(err, errNotFound) {
		t.Fatalf("device can access another device's session: %v", err)
	}
	if _, err := repo.createSession(ctx, copyDevice, session); !errors.Is(err, errConflict) {
		t.Fatalf("device can claim another device's asset: %v", err)
	}

	change := mutation{Kind: editTemplates, OrderNumber: in.OrderNumber, AssetID: in.AssetID, ExpectedVersion: 1,
		RequestID: "12121212121212121212121212121212", Templates: []template{{ID: "pink", Quantity: 4}}}
	if version, err := repo.mutate(ctx, d, change); version != 2 || err != nil {
		t.Fatalf("apply change: version=%d err=%v", version, err)
	}
	s, err := repo.getOrder(ctx, copyDevice, in.OrderNumber)
	if err != nil || s.Version != 2 || len(s.Assets) != 1 || s.Assets[0].Templates[0] != change.Templates[0] {
		t.Fatalf("unexpected order: %+v err=%v", s, err)
	}
	bucket, key, err := repo.assetKey(ctx, copyDevice, in.AssetID)
	if err != nil || bucket != session.Bucket || key != session.Key {
		t.Fatalf("asset download lookup: bucket=%q key=%q err=%v", bucket, key, err)
	}
	if version, err := repo.mutate(ctx, d, change); version != 2 || err != nil {
		t.Fatalf("retry after lost response: version=%d err=%v", version, err)
	}
	reused := change
	reused.Templates = []template{{ID: "other", Quantity: 4}}
	if _, err := repo.mutate(ctx, d, reused); !errors.Is(err, errConflict) {
		t.Fatalf("expected request identity conflict; got %v", err)
	}
	stale := change
	stale.RequestID = "98989898989898989898989898989898"
	if _, err := repo.mutate(ctx, d, stale); !errors.Is(err, errStale) {
		t.Fatalf("expected version conflict; got %v", err)
	}
	if version, err := repo.completeSession(ctx, d, session); version != 1 || err != nil {
		t.Fatalf("completion retry after later edit: version=%d err=%v", version, err)
	}

	product := session
	product.ID = "30000000000000000000000000000000"
	product.Input.RequestID = "31000000000000000000000000000000"
	product.Input.AssetID = "32000000000000000000000000000000"
	product.Key = "unit-production"
	product.Input.Kind = kindProduction
	product.Input.SourceImageID = "33000000000000000000000000000000"
	product.Fingerprint = fingerprint(product.Input)
	if _, err := repo.createSession(ctx, d, product); !errors.Is(err, errNotFound) {
		t.Fatalf("production accepted a missing original: %v", err)
	}
	product.Input.SourceImageID = in.AssetID
	product.Fingerprint = fingerprint(product.Input)
	if _, err := repo.createSession(ctx, d, product); err != nil {
		t.Fatal(err)
	}
	type completion struct {
		version int64
		err     error
	}
	completions := make(chan completion, 2)
	start := make(chan struct{})
	for range 2 {
		go func() {
			<-start
			version, err := repo.completeSession(ctx, d, product)
			completions <- completion{version, err}
		}()
	}
	close(start)
	for range 2 {
		result := <-completions
		if result.version != 3 || result.err != nil {
			t.Fatalf("concurrent product publication: version=%d err=%v", result.version, result.err)
		}
	}
	removeImage := mutation{Kind: deleteImage, OrderNumber: in.OrderNumber, AssetID: in.AssetID, ExpectedVersion: 3, RequestID: "78787878787878787878787878787878"}
	if version, err := repo.mutate(ctx, d, removeImage); version != 4 || err != nil {
		t.Fatalf("image deletion: version=%d err=%v", version, err)
	}
	s, err = repo.getOrder(ctx, d, in.OrderNumber)
	if err != nil || s.Version != 4 || len(s.Assets) != 2 || !s.Assets[0].Deleted || s.Assets[1].SourceImageID != in.AssetID {
		t.Fatalf("missing deletion tombstone or production: %+v err=%v", s, err)
	}
	if _, _, err := repo.assetKey(ctx, d, in.AssetID); !errors.Is(err, errNotFound) {
		t.Fatalf("deleted asset remains downloadable: %v", err)
	}
	deletePending.ExpectedVersion = 4
	if version, err := repo.mutate(ctx, d, deletePending); version != 5 || err != nil {
		t.Fatalf("order deletion: version=%d err=%v", version, err)
	}
	page, err := repo.listOrders(ctx, d, "", 1)
	if err != nil || len(page.Orders) != 1 || !page.Orders[0].Deleted || page.Orders[0].Version != 5 || page.Next != nil {
		t.Fatalf("missing order tombstone: %+v err=%v", page, err)
	}
	if _, _, err := repo.assetKey(ctx, d, product.Input.AssetID); !errors.Is(err, errNotFound) {
		t.Fatalf("asset of deleted order remains downloadable: %v", err)
	}
	newOriginal := session
	newOriginal.ID = "40000000000000000000000000000000"
	newOriginal.Input.RequestID = "41000000000000000000000000000000"
	newOriginal.Input.AssetID = "42000000000000000000000000000000"
	newOriginal.Key = "unit-undelete"
	newOriginal.Fingerprint = fingerprint(newOriginal.Input)
	if _, err := repo.createSession(ctx, d, newOriginal); !errors.Is(err, errConflict) {
		t.Fatalf("new upload can revive deleted order: %v", err)
	}
}
