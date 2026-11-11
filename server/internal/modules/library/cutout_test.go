package library

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

func tinyPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type cutoutUpstream struct {
	server *httptest.Server
	hits   int32
	mu     sync.Mutex
	// Configurable behaviour for the segmentation call.
	status  int  // HTTP status of the segmentation response; 200 with body when 0 default handled via state
	state   int  // data.state in a 200 response
	failGet bool // make the result download return 500
	sawKey  string
	sawSync string
	sawType string
	sawCrop string
	sawFile bool
}

// newCutoutUpstream serves both the segmentation endpoint and the result image.
func newCutoutUpstream(t *testing.T) *cutoutUpstream {
	t.Helper()
	up := &cutoutUpstream{state: 1}
	up.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&up.hits, 1)
		switch r.URL.Path {
		case "/api/tasks/visual/segmentation":
			_ = r.ParseMultipartForm(1 << 20)
			up.mu.Lock()
			up.sawKey = r.Header.Get("X-API-KEY")
			up.sawSync, up.sawType = r.FormValue("sync"), r.FormValue("type")
			up.sawCrop = r.FormValue("crop")
			up.sawFile = len(r.MultipartForm.File["image_file"]) > 0
			status, state := up.status, up.state
			up.mu.Unlock()
			if status != 0 && status != http.StatusOK {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"status":` + jsonNumber(status) + `,"message":"upstream busy"}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":200,"message":"success","data":{"state":` + jsonNumber(state) + `,"image":"` + up.server.URL + `/result.png","task_id":"t1"}}`))
		case "/result.png":
			up.mu.Lock()
			failGet := up.failGet
			up.mu.Unlock()
			if failGet {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(tinyPNG(t, 4, 3))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(up.server.Close)
	return up
}

func jsonNumber(value int) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

func setupCutout(t *testing.T, configure func(*Options)) (http.Handler, *memoryStore, *cutoutUpstream) {
	t.Helper()
	up := newCutoutUpstream(t)
	store := newMemory()
	opts := Options{Username: "staff", Password: "test-password-only", SessionKey: "test-session-key-at-least-32-bytes",
		Origin: "http://localhost:5173", DataDir: t.TempDir(), PicWishAPIKey: "test-key", PicWishURL: up.server.URL}
	if configure != nil {
		configure(&opts)
	}
	h, err := NewHandler(store, opts)
	if err != nil {
		t.Fatal(err)
	}
	return h, store, up
}

func postCutout(h http.Handler, cookie *http.Cookie, data []byte) *httptest.ResponseRecorder {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "photo.png")
	_, _ = part.Write(data)
	_ = writer.Close()
	r := httptest.NewRequest("POST", "/api/v1/photos/cutout", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Origin", "http://localhost:5173")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

type cutoutReply struct {
	Code int `json:"code"`
	Data struct {
		ID     string `json:"id"`
		MIME   string `json:"mime"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
		Cached bool   `json:"cached"`
	} `json:"data"`
}

func TestCutoutRequiresLogin(t *testing.T) {
	h, _, _ := setupCutout(t, nil)
	if w := postCutout(h, nil, tinyPNG(t, 2, 2)); w.Code != 401 {
		t.Fatalf("expected 401 without cookie, got %d %s", w.Code, w.Body)
	}
}

func TestCutoutWithoutKeyReturnsServiceUnavailable(t *testing.T) {
	h, _, up := setupCutout(t, func(o *Options) { o.PicWishAPIKey = "" })
	cookie := login(t, h)
	w := postCutout(h, cookie, tinyPNG(t, 2, 2))
	if w.Code != 503 {
		t.Fatalf("expected 503, got %d %s", w.Code, w.Body)
	}
	if atomic.LoadInt32(&up.hits) != 0 {
		t.Fatal("upstream must not be called without a key")
	}
}

func TestCutoutSegmentSuccessCacheAndAssetDownload(t *testing.T) {
	h, store, up := setupCutout(t, nil)
	cookie := login(t, h)

	first := tinyPNG(t, 3, 2)
	w := postCutout(h, cookie, first)
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d %s", w.Code, w.Body)
	}
	var reply cutoutReply
	if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	if reply.Code != 0 || reply.Data.ID == "" || len(reply.Data.ID) != 32 || reply.Data.MIME != "image/png" || reply.Data.Cached {
		t.Fatalf("unexpected reply: %+v", reply)
	}
	if reply.Data.Width != 4 || reply.Data.Height != 3 {
		t.Fatalf("expected result dimensions 4x3, got %dx%d", reply.Data.Width, reply.Data.Height)
	}
	if up.sawKey != "test-key" || up.sawSync != "1" || up.sawType != "person" || up.sawCrop != "1" || !up.sawFile {
		t.Fatalf("upstream request missing key/sync/type/crop/file: %q %q %q %q %v", up.sawKey, up.sawSync, up.sawType, up.sawCrop, up.sawFile)
	}
	if hits := atomic.LoadInt32(&up.hits); hits != 2 { // segmentation + result download
		t.Fatalf("expected 2 upstream hits, got %d", hits)
	}

	// The saved asset downloads through the existing private asset endpoint.
	r := httptest.NewRequest("GET", "/api/v1/assets/"+reply.Data.ID, nil)
	r.Header.Set("Origin", "http://localhost:5173")
	r.AddCookie(cookie)
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, r)
	if recorder.Code != 200 || recorder.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("asset download failed: %d %s", recorder.Code, recorder.Header().Get("Content-Type"))
	}
	if got, _ := io.ReadAll(recorder.Body); len(got) == 0 {
		t.Fatal("asset download returned empty body")
	}

	// Identical bytes hit the content cache: no extra upstream calls, cached=true.
	cached := postCutout(h, cookie, first)
	if cached.Code != 200 {
		t.Fatalf("cached call: %d %s", cached.Code, cached.Body)
	}
	var second cutoutReply
	if err := json.Unmarshal(cached.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if !second.Data.Cached || second.Data.ID != reply.Data.ID {
		t.Fatalf("expected cached hit with same id, got %+v", second)
	}
	if hits := atomic.LoadInt32(&up.hits); hits != 2 {
		t.Fatalf("cache must not call upstream, hits=%d", hits)
	}

	// Different bytes trigger a fresh segmentation.
	third := postCutout(h, cookie, tinyPNG(t, 5, 4))
	if third.Code != 200 {
		t.Fatalf("new image: %d %s", third.Code, third.Body)
	}
	if hits := atomic.LoadInt32(&up.hits); hits != 4 {
		t.Fatalf("expected 2 more upstream hits, got %d", hits)
	}
	if _, err := store.Asset(nil, reply.Data.ID); err != nil {
		t.Fatalf("asset record missing: %v", err)
	}
}

func TestCutoutRejectsOversizeImage(t *testing.T) {
	h, _, up := setupCutout(t, nil)
	cookie := login(t, h)
	w := postCutout(h, cookie, tinyPNG(t, 4097, 1))
	if w.Code != 400 {
		t.Fatalf("expected 400, got %d %s", w.Code, w.Body)
	}
	if atomic.LoadInt32(&up.hits) != 0 {
		t.Fatal("oversize image must not reach upstream")
	}
}

func TestCutoutMapsUpstreamErrors(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		state    int
		failGet  bool
		wantCode int
	}{
		{name: "upstream 429 passes through", status: 429, wantCode: 429},
		{name: "upstream 401 maps to 502", status: 401, wantCode: 502},
		{name: "pending state maps to 502", state: 2, wantCode: 502},
		{name: "result download failure maps to 502", failGet: true, wantCode: 502},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _, up := setupCutout(t, func(o *Options) { o.PicWishDailyLimit = 10 })
			cookie := login(t, h)
			up.mu.Lock()
			up.status, up.state, up.failGet = tc.status, tc.state, tc.failGet
			up.mu.Unlock()
			w := postCutout(h, cookie, tinyPNG(t, 2, 2))
			if w.Code != tc.wantCode {
				t.Fatalf("expected %d, got %d %s", tc.wantCode, w.Code, w.Body)
			}
		})
	}
}

func TestCutoutDailyLimitRefundsUpstreamFailures(t *testing.T) {
	h, _, up := setupCutout(t, func(o *Options) { o.PicWishDailyLimit = 1 })
	cookie := login(t, h)

	// The single daily slot is spent but the upstream fails, so it must be refunded.
	up.mu.Lock()
	up.status = 500
	up.mu.Unlock()
	if w := postCutout(h, cookie, tinyPNG(t, 2, 2)); w.Code != 502 {
		t.Fatalf("expected 502, got %d %s", w.Code, w.Body)
	}

	up.mu.Lock()
	up.status = 0
	up.mu.Unlock()
	if w := postCutout(h, cookie, tinyPNG(t, 3, 2)); w.Code != 200 {
		t.Fatalf("refund must allow a retry, got %d %s", w.Code, w.Body)
	}

	// A successful call consumed the slot; the next different image is rejected.
	if w := postCutout(h, cookie, tinyPNG(t, 4, 2)); w.Code != 429 {
		t.Fatalf("expected 429 after budget exhausted, got %d %s", w.Code, w.Body)
	}
	// Cache hits stay free even with the budget exhausted.
	if w := postCutout(h, cookie, tinyPNG(t, 3, 2)); w.Code != 200 {
		t.Fatalf("cache hit must bypass the budget, got %d %s", w.Code, w.Body)
	}
}
