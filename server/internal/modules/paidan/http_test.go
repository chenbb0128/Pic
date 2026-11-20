package paidan

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var errTestDatabase = errors.New("paidan MySQL connection failed")

const testToken = "test-device-token"
const originalID = "aabbccddeeff00112233aabbccddeeff"
const requestID = "01010101010101010101010101010101"
const testSHA = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
const testETag = "FlbcmXloGRHmmRv0NPRP4GLpiiut"

func testDevice(role string) Device {
	return Device{ID: "device-1", Workspace: "space-a", Role: role}
}

type fakeRepository struct {
	repository
	session       storedSession
	completeCalls int
	onMutate      func(Device, mutation) (int64, error)
	readinessErr  error
}

func (r *fakeRepository) ready(context.Context) error {
	return r.readinessErr
}

func (r *fakeRepository) createSession(_ context.Context, device Device, session storedSession) (storedSession, error) {
	if r.session.ID == "" {
		r.session = session
	} else if r.session.Fingerprint != session.Fingerprint {
		return storedSession{}, errConflict
	}
	return r.session, nil
}

func (r *fakeRepository) getSession(_ context.Context, _ Device, id string) (storedSession, error) {
	if id != r.session.ID {
		return storedSession{}, errNotFound
	}
	return r.session, nil
}

func (r *fakeRepository) completeSession(_ context.Context, _ Device, _ storedSession) (int64, error) {
	r.completeCalls++
	r.session.Version = 4
	return r.session.Version, nil
}

func (r *fakeRepository) mutate(_ context.Context, d Device, m mutation) (int64, error) {
	return r.onMutate(d, m)
}

type fakeObjectStore struct {
	object  objectInfo
	statErr error
	key     string
}

func (s *fakeObjectStore) upload(key string, _ uploadInput) (string, string) {
	s.key = key
	return "https://upload.example.com", "test-upload-token"
}

func (s *fakeObjectStore) stat(_ context.Context, _ string) (objectInfo, error) {
	return s.object, s.statErr
}

func (s *fakeObjectStore) download(string) string {
	return "https://download.example.com"
}

func testHandler(t *testing.T, role string, repo repository, objects objectStore) http.Handler {
	t.Helper()
	digest := sha256.Sum256([]byte(testToken))
	device := testDevice(role)
	devices, err := parseDevices(`[{"deviceId":"` + device.ID + `","workspaceId":"` + device.Workspace + `","role":"` + device.Role + `","tokenSha256":"` + hex.EncodeToString(digest[:]) + `"}]`)
	if err != nil {
		t.Fatal(err)
	}
	return newHandler(devices, repo, objects, defaultFileLimit, "test-bucket")
}

func apiRequest(t *testing.T, h http.Handler, method, path, token, payload string, status int) map[string]any {
	t.Helper()
	req := httptest.NewRequest(method, "/api/v1/paidan"+path, strings.NewReader(payload))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != status {
		t.Fatalf("%s %s: got HTTP %d, want %d: %s", method, path, rec.Code, status, rec.Body)
	}
	result := make(map[string]any)
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("response must use the JSON contract: %v", err)
	}
	return result
}

func TestDeviceAuthenticationAndRoles(t *testing.T) {
	handler := testHandler(t, "production", &fakeRepository{}, nil)
	for _, token := range []string{"", "bad-token"} {
		result := apiRequest(t, handler, "GET", "/device", token, "", 401)
		if result["code"] != "unauthorized" || result["message"] == "" {
			t.Fatalf("unexpected error: %+v", result)
		}
	}
	result := apiRequest(t, handler, "GET", "/device", testToken, "", 200)
	if result["deviceId"] != "device-1" || result["workspaceId"] != "space-a" || result["role"] != "production" ||
		result["maxFileBytes"] != float64(100*1024*1024) || len(result) != 4 {
		t.Fatalf("unexpected device info: %+v", result)
	}
	apiRequest(t, handler, "POST", "/upload-sessions", testToken, validUploadJSON("7"), 403)
	apiRequest(t, handler, "DELETE", "/orders/7", testToken, `{"expectedVersion":1,"requestId":"`+requestID+`"}`, 403)
}

func TestDeviceReportsDatabaseUnavailableAfterAuthentication(t *testing.T) {
	handler := testHandler(t, "production", &fakeRepository{readinessErr: errTestDatabase}, nil)
	apiRequest(t, handler, "GET", "/device", "", "", 401)
	result := apiRequest(t, handler, "GET", "/device", testToken, "", 503)
	if result["code"] != "database_unavailable" {
		t.Fatalf("unexpected diagnostic: %+v", result)
	}
}

func validUploadJSON(number string) string {
	return `{"requestId":"` + requestID + `","assetId":"` + originalID + `","kind":"original","orderNumber":"` + number +
		`","fileName":"photo.png","mime":"image/png","byteLength":32,"width":8,"height":4,"sha256":"` + testSHA +
		`","etag":"` + testETag + `","templates":[{"templateId":"爱心模板.png","quantity":2}],"metadata":"客户备注"}`
}

func TestCompletionChecksObjectAndReturnsSameVersionOnRetry(t *testing.T) {
	repo := &fakeRepository{}
	objects := &fakeObjectStore{object: objectInfo{Size: 31, ETag: testETag}}
	handler := testHandler(t, "customer", repo, objects)
	begin := apiRequest(t, handler, "POST", "/upload-sessions", testToken, validUploadJSON("7"), 200)
	id, ok := begin["id"].(string)
	if !ok || len(id) != 32 || begin["completed"] != false ||
		begin["key"] != "paidan/v1/space-a/originals/"+originalID+".png" || begin["token"] != "test-upload-token" {
		t.Fatalf("unexpected upload session: %+v", begin)
	}
	apiRequest(t, handler, "POST", "/upload-sessions", testToken, validUploadJSON("8"), 409)
	path := "/upload-sessions/" + id + "/complete"
	objects.statErr = errObjectMissing
	if answer := apiRequest(t, handler, "POST", path, testToken, "", 409); answer["code"] != "upload_missing" {
		t.Fatalf("missing object response: %+v", answer)
	}
	objects.statErr = nil
	apiRequest(t, handler, "POST", path, testToken, "", 409)
	objects.object.Size = 32
	objects.object.ETag = "wrong-etag"
	apiRequest(t, handler, "POST", path, testToken, "", 409)
	if repo.completeCalls != 0 {
		t.Fatal("a mismatched object was published")
	}
	objects.object.ETag = testETag
	first := apiRequest(t, handler, "POST", path, testToken, "", 200)
	objects.statErr = errUpstream
	retry := apiRequest(t, handler, "POST", path, testToken, "", 200)
	if first["version"] != float64(4) || retry["version"] != first["version"] || repo.completeCalls != 1 {
		t.Fatalf("completion did not preserve its result: %+v %+v, calls=%d", first, retry, repo.completeCalls)
	}
	resumed := apiRequest(t, handler, "POST", "/upload-sessions", testToken, validUploadJSON("7"), 200)
	if resumed["completed"] != true || resumed["version"] != first["version"] || resumed["token"] != "" {
		t.Fatalf("completed session returned another upload token: %+v", resumed)
	}
}

func TestTemplateRevisionConflict(t *testing.T) {
	repo := &fakeRepository{onMutate: func(d Device, change mutation) (int64, error) {
		if d.Workspace != "space-a" || change.OrderNumber != "100" || change.AssetID != originalID ||
			change.RequestID != requestID || change.ExpectedVersion != 2 || len(change.Templates) != 1 {
			t.Fatalf("unexpected scoped mutation: %+v %+v", d, change)
		}
		return 0, errStale
	}}
	handler := testHandler(t, "production", repo, nil)
	body := `{"expectedVersion":2,"requestId":"` + requestID + `","templates":[{"templateId":"heart","quantity":1}]}`
	result := apiRequest(t, handler, "PATCH", "/orders/100/images/"+originalID+"/templates", testToken, body, 409)
	if result["code"] != "stale_version" {
		t.Fatalf("unexpected conflict: %+v", result)
	}
}
