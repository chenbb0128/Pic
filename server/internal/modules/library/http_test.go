package library

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The memory repository is test-only. Production always uses MySQL.
type memoryStore struct {
	mu       sync.Mutex
	sessions map[string]Session
	assets   map[string]Asset
	docs     map[string]Document
}

func newMemory() *memoryStore {
	return &memoryStore{sessions: map[string]Session{}, assets: map[string]Asset{}, docs: map[string]Document{}}
}
func (s *memoryStore) SaveSession(_ context.Context, key, credential string, expires time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[key] = Session{Credential: credential, Expires: expires}
	return nil
}
func (s *memoryStore) Session(_ context.Context, key string) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.sessions[key]
	if !ok {
		return v, ErrNotFound
	}
	return v, nil
}
func (s *memoryStore) DeleteSession(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, key)
	return nil
}
func (s *memoryStore) CreateAsset(_ context.Context, a Asset) error { s.assets[a.ID] = a; return nil }
func (s *memoryStore) Asset(_ context.Context, id string) (Asset, error) {
	a, ok := s.assets[id]
	if !ok {
		return a, ErrNotFound
	}
	return a, nil
}
func (s *memoryStore) List(_ context.Context, kind string, offset int, query string) ([]Document, error) {
	list := []Document{}
	for _, d := range s.docs {
		if d.Kind == kind && (query == "" || strings.Contains(d.Name, query) || strings.Contains(d.Number, query)) {
			d.Snapshot = nil
			list = append(list, d)
		}
	}
	return list, nil
}
func (s *memoryStore) Get(_ context.Context, kind, id string) (Document, error) {
	d, ok := s.docs[id]
	if !ok || d.Kind != kind {
		return d, ErrNotFound
	}
	return d, nil
}
func (s *memoryStore) Save(_ context.Context, d Document, refs []string, version int64) (Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range refs {
		if _, ok := s.assets[id]; !ok {
			return d, ErrInvalid
		}
	}
	old, ok := s.docs[d.ID]
	if version == 0 {
		if ok {
			return d, ErrConflict
		}
	} else if !ok || old.Kind != d.Kind {
		return d, ErrNotFound
	} else if old.Version != version {
		return d, ErrConflict
	}
	d.Version = version + 1
	s.docs[d.ID] = d
	return d, nil
}
func (s *memoryStore) Delete(_ context.Context, kind, id string, version int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.docs[id]
	if !ok || d.Kind != kind {
		return ErrNotFound
	}
	if d.Version != version {
		return ErrConflict
	}
	delete(s.docs, id)
	return nil
}

func setupHTTP(t *testing.T) (http.Handler, *memoryStore, Options) {
	t.Helper()
	s := newMemory()
	opts := Options{Username: "staff", Password: "test-password-only", SessionKey: "test-session-key-at-least-32-bytes", Origin: "http://localhost:5173", DataDir: t.TempDir()}
	h, err := NewHandler(s, opts)
	if err != nil {
		t.Fatal(err)
	}
	return h, s, opts
}
func request(h http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://localhost:5173")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func login(t *testing.T, h http.Handler) *http.Cookie {
	t.Helper()
	w := request(h, "POST", "/api/v1/session", `{"username":"staff","password":"test-password-only"}`, nil)
	if w.Code != 200 {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	return w.Result().Cookies()[0]
}
func TestPrivateRoutesRequireLogin(t *testing.T) {
	h, _, _ := setupHTTP(t)
	for _, p := range []string{"/api/v1/projects", "/api/v1/templates", "/api/v1/assets/0123456789abcdef0123456789abcdef"} {
		if w := request(h, "GET", p, "", nil); w.Code != 401 {
			t.Fatalf("%s: %d", p, w.Code)
		}
	}
}
func TestSuccessfulLoginsDoNotExhaustSharedProxyLimit(t *testing.T) {
	h, _, _ := setupHTTP(t)
	for range 12 {
		login(t, h)
	}
}
func TestSessionLoginExpiryLogoutAndPasswordChange(t *testing.T) {
	h, s, opts := setupHTTP(t)
	if w := request(h, "POST", "/api/v1/session", `{"username":"staff","password":"wrong"}`, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	cookie := login(t, h)
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != 30*86400 {
		t.Fatalf("unsafe cookie: %+v", cookie)
	}
	if w := request(h, "GET", "/api/v1/session", "", cookie); w.Code != 200 {
		t.Fatal(w.Code)
	}
	opts.Password = "a-new-test-password"
	changed, _ := NewHandler(s, opts)
	if w := request(changed, "GET", "/api/v1/session", "", cookie); w.Code != 401 {
		t.Fatal("password change retained session")
	}
	for key, session := range s.sessions {
		session.Expires = time.Now().Add(-time.Hour)
		s.sessions[key] = session
	}
	if w := request(h, "GET", "/api/v1/session", "", cookie); w.Code != 401 {
		t.Fatal("expired session accepted")
	}
	cookie = login(t, h)
	request(h, "DELETE", "/api/v1/session", "", cookie)
	if w := request(h, "GET", "/api/v1/session", "", cookie); w.Code != 401 {
		t.Fatal("logout retained session")
	}
}
func TestWritesRejectOtherOrigins(t *testing.T) {
	h, _, _ := setupHTTP(t)
	cookie := login(t, h)
	for _, origin := range []string{"", "http://evil.example", "null"} {
		r := httptest.NewRequest("POST", "/api/v1/projects", strings.NewReader(`{}`))
		r.AddCookie(cookie)
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("origin %q: %d", origin, w.Code)
		}
	}
}
func TestDocumentsShareSnapshotAndRejectStaleWrites(t *testing.T) {
	h, s, _ := setupHTTP(t)
	cookie := login(t, h)
	s.assets["0123456789abcdef0123456789abcdef"] = Asset{}
	body := `{"name":"客户排版","snapshot":` + string(snapshot()) + `}`
	w := request(h, "POST", "/api/v1/projects", body, cookie)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var result struct{ Data Document }
	json.Unmarshal(w.Body.Bytes(), &result)
	path := "/api/v1/projects/" + result.Data.ID
	other := login(t, h)
	if w = request(h, "GET", path, "", other); w.Code != 200 {
		t.Fatal("other staff cannot read")
	}
	update := `{"name":"新排版","version":1,"snapshot":` + string(snapshot()) + `}`
	if w = request(h, "PUT", path, update, other); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if w = request(h, "PUT", path, update, cookie); w.Code != 409 {
		t.Fatal("stale save accepted", w.Code)
	}
	if w = request(h, "DELETE", path, `{"version":1}`, cookie); w.Code != 409 {
		t.Fatal("stale delete accepted")
	}
	if w = request(h, "GET", "/api/v1/projects", "", cookie); strings.Contains(w.Body.String(), "schemaVersion") {
		t.Fatal("list leaked snapshot")
	}
}
func TestDocumentRejectsMissingAsset(t *testing.T) {
	h, _, _ := setupHTTP(t)
	cookie := login(t, h)
	w := request(h, "POST", "/api/v1/projects", `{"name":"x","snapshot":`+string(snapshot())+`}`, cookie)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}
func TestUploadRoundTripAndRejectsNonImage(t *testing.T) {
	h, _, _ := setupHTTP(t)
	cookie := login(t, h)
	upload := func(data []byte) *httptest.ResponseRecorder {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		part, _ := form.CreateFormFile("file", "../../bad.png")
		part.Write(data)
		form.Close()
		r := httptest.NewRequest("POST", "/api/v1/assets", &body)
		r.AddCookie(cookie)
		r.Header.Set("Origin", "http://localhost:5173")
		r.Header.Set("Content-Type", form.FormDataContentType())
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := upload([]byte("<svg onload='alert(1)'/>")); w.Code != 400 {
		t.Fatal("accepted active content", w.Code)
	}
	var pngData bytes.Buffer
	png.Encode(&pngData, image.NewNRGBA(image.Rect(0, 0, 3, 4)))
	w := upload(pngData.Bytes())
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body)
	}
	var result struct{ Data Asset }
	json.Unmarshal(w.Body.Bytes(), &result)
	w = request(h, "GET", "/api/v1/assets/"+result.Data.ID, "", cookie)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), pngData.Bytes()) {
		t.Fatal("file mismatch", w.Code)
	}
	if w.Header().Get("Cache-Control") != "private, no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("unsafe file headers")
	}
}
