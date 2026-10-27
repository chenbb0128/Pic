package library

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const cookieName = "pic_session"

type Options struct {
	Username, Password, SessionKey, Origin, DataDir string
	ToolPassword                                    string
	SecureCookie                                    bool
}
type attempts struct {
	Count int
	Until time.Time
}
type handler struct {
	store      Store
	opts       Options
	credential string
	mu         sync.Mutex
	attempts   map[string]attempts
}

func NewHandler(store Store, opts Options) (http.Handler, error) {
	u, err := url.Parse(opts.Origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("PIC_ORIGIN must be a single origin without path")
	}
	if strings.TrimSpace(opts.Username) == "" || len(opts.Password) < 12 || len(opts.SessionKey) < 32 || opts.DataDir == "" || store == nil {
		return nil, fmt.Errorf("library requires username, password (12+ bytes), session key (32+ bytes), data directory and MySQL")
	}
	if opts.ToolPassword != "" && len(opts.ToolPassword) < 8 {
		return nil, fmt.Errorf("PIC_TOOL_PASSWORD must be at least 8 bytes")
	}
	if err := os.MkdirAll(opts.DataDir, 0700); err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, []byte(opts.SessionKey))
	mac.Write([]byte(opts.Username + "\x00" + opts.Password))
	if opts.ToolPassword != "" {
		mac.Write([]byte("\x00" + opts.ToolPassword))
	}
	h := &handler{store: store, opts: opts, credential: hex.EncodeToString(mac.Sum(nil)), attempts: map[string]attempts{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/session", h.login)
	mux.HandleFunc("POST /api/v1/tool-session", h.toolLogin)
	mux.HandleFunc("GET /api/v1/session", func(w http.ResponseWriter, r *http.Request) {
		h.reply(w, 200, map[string]string{"username": opts.Username})
	})
	mux.HandleFunc("DELETE /api/v1/session", h.logout)
	mux.HandleFunc("POST /api/v1/assets", h.upload)
	mux.HandleFunc("GET /api/v1/assets/{id}", h.download)
	for _, collection := range []string{"projects", "templates"} {
		kind := strings.TrimSuffix(collection, "s")
		prefix := "/api/v1/" + collection
		mux.HandleFunc("GET "+prefix, func(w http.ResponseWriter, r *http.Request) { h.list(w, r, kind) })
		mux.HandleFunc("POST "+prefix, func(w http.ResponseWriter, r *http.Request) { h.save(w, r, kind, false) })
		mux.HandleFunc("GET "+prefix+"/{id}", func(w http.ResponseWriter, r *http.Request) { h.get(w, r, kind) })
		mux.HandleFunc("PUT "+prefix+"/{id}", func(w http.ResponseWriter, r *http.Request) { h.save(w, r, kind, true) })
		mux.HandleFunc("DELETE "+prefix+"/{id}", func(w http.ResponseWriter, r *http.Request) { h.remove(w, r, kind) })
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("Origin") != opts.Origin {
			h.fail(w, 403, "请求来源不被允许")
			return
		}
		isLogin := r.Method == "POST" && (r.URL.Path == "/api/v1/session" || r.URL.Path == "/api/v1/tool-session")
		if !isLogin {
			if !h.authorized(r) {
				h.fail(w, 401, "访问验证已过期，请重新输入工具访问密码")
				return
			}
		}
		mux.ServeHTTP(w, r)
	}), nil
}
func digest(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func randomID(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
func (h *handler) authorized(r *http.Request) bool {
	cookie, err := r.Cookie(cookieName)
	if err != nil || len(cookie.Value) != 64 {
		return false
	}
	session, err := h.store.Session(r.Context(), digest(cookie.Value))
	if err != nil {
		return false
	}
	return time.Now().Before(session.Expires) && hmac.Equal([]byte(session.Credential), []byte(h.credential))
}
func (h *handler) reply(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"code": 0, "message": "success", "data": data})
}
func (h *handler) fail(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"code": status, "message": message})
}
func (h *handler) error(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalid):
		h.fail(w, 400, "参数无效或引用的图片不存在")
	case errors.Is(err, ErrNotFound):
		h.fail(w, 404, "内容不存在或已被删除")
	case errors.Is(err, ErrConflict):
		h.fail(w, 409, "其他人已修改此内容，请重新打开或另存一份；你的编辑没有被覆盖")
	default:
		slog.Error("library operation failed", "error", err)
		h.fail(w, 500, "保存服务暂不可用，请稍后重试")
	}
}
func decode(w http.ResponseWriter, r *http.Request, value any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return ErrInvalid
	}
	if decoder.Decode(new(any)) != io.EOF {
		return ErrInvalid
	}
	return nil
}
func (h *handler) allowLogin(r *http.Request) bool {
	// Do not trust forwarded headers: the deployment proxy must rate-limit too.
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, a := range h.attempts {
		if now.After(a.Until) {
			delete(h.attempts, key)
		}
	}
	a := h.attempts[ip]
	if a.Count >= 10 || len(h.attempts) >= 4096 {
		return false
	}
	if a.Count == 0 {
		a.Until = now.Add(10 * time.Minute)
	}
	a.Count++
	h.attempts[ip] = a
	return true
}
func (h *handler) login(w http.ResponseWriter, r *http.Request) {
	if !h.allowLogin(r) {
		w.Header().Set("Retry-After", "600")
		h.fail(w, 429, "登录尝试过多，请稍后重试")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if decode(w, r, &body, 4096) != nil {
		h.error(w, ErrInvalid)
		return
	}
	u, p := sha256.Sum256([]byte(body.Username)), sha256.Sum256([]byte(body.Password))
	wantU, wantP := sha256.Sum256([]byte(h.opts.Username)), sha256.Sum256([]byte(h.opts.Password))
	if subtle.ConstantTimeCompare(u[:], wantU[:])&subtle.ConstantTimeCompare(p[:], wantP[:]) != 1 {
		h.fail(w, 401, "用户名或密码不正确")
		return
	}
	h.startSession(w, r)
}
func (h *handler) toolLogin(w http.ResponseWriter, r *http.Request) {
	if h.opts.ToolPassword == "" {
		h.fail(w, 503, "工具访问密码尚未配置，请联系维护人员设置 PIC_TOOL_PASSWORD")
		return
	}
	if !h.allowLogin(r) {
		w.Header().Set("Retry-After", "600")
		h.fail(w, 429, "验证尝试过多，请稍后重试")
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if decode(w, r, &body, 4096) != nil {
		h.error(w, ErrInvalid)
		return
	}
	got, want := sha256.Sum256([]byte(body.Password)), sha256.Sum256([]byte(h.opts.ToolPassword))
	if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
		h.fail(w, 401, "密码错误，请重新输入。")
		return
	}
	h.startSession(w, r)
}
func (h *handler) startSession(w http.ResponseWriter, r *http.Request) {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	h.mu.Lock()
	delete(h.attempts, ip)
	h.mu.Unlock()
	token, err := randomID(32)
	if err != nil {
		h.error(w, err)
		return
	}
	expires := time.Now().Add(30 * 24 * time.Hour)
	if err = h.store.SaveSession(r.Context(), digest(token), h.credential, expires); err != nil {
		h.error(w, err)
		return
	}
	h.cookie(w, token, 30*86400, expires)
	h.reply(w, 200, map[string]string{"username": h.opts.Username})
}
func (h *handler) cookie(w http.ResponseWriter, value string, age int, expires time.Time) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: value, Path: "/api/v1", MaxAge: age, Expires: expires, HttpOnly: true, Secure: h.opts.SecureCookie, SameSite: http.SameSiteStrictMode})
}
func (h *handler) logout(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Cookie(cookieName)
	if c != nil {
		if err := h.store.DeleteSession(r.Context(), digest(c.Value)); err != nil {
			h.error(w, err)
			return
		}
	}
	h.cookie(w, "", -1, time.Unix(1, 0))
	h.reply(w, 200, nil)
}
func (h *handler) list(w http.ResponseWriter, r *http.Request, kind string) {
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if offset < 0 || offset > 100000 || utf8.RuneCountInString(query) > 200 {
		h.error(w, ErrInvalid)
		return
	}
	docs, err := h.store.List(r.Context(), kind, offset, query)
	if err != nil {
		h.error(w, err)
		return
	}
	h.reply(w, 200, docs)
}
func (h *handler) get(w http.ResponseWriter, r *http.Request, kind string) {
	id := r.PathValue("id")
	if !validID(id) {
		h.error(w, ErrNotFound)
		return
	}
	doc, err := h.store.Get(r.Context(), kind, id)
	if err != nil {
		h.error(w, err)
		return
	}
	h.reply(w, 200, doc)
}
func (h *handler) save(w http.ResponseWriter, r *http.Request, kind string, update bool) {
	var body struct {
		Name        string          `json:"name"`
		Version     int64           `json:"version"`
		Snapshot    json.RawMessage `json:"snapshot"`
		ThumbnailID string          `json:"thumbnailId"`
		ResultID    string          `json:"resultId"`
	}
	if decode(w, r, &body, 3<<20) != nil {
		h.error(w, ErrInvalid)
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || utf8.RuneCountInString(body.Name) > 100 || strings.ContainsAny(body.Name, "\x00\r\n") || (update && body.Version < 1) || (!update && body.Version != 0) {
		h.error(w, ErrInvalid)
		return
	}
	refs, err := ValidateSnapshot(kind, body.Snapshot)
	if err != nil {
		h.error(w, err)
		return
	}
	var metadata struct {
		Settings struct {
			FooterText string `json:"footerText"`
		} `json:"settings"`
	}
	json.Unmarshal(body.Snapshot, &metadata)
	if utf8.RuneCountInString(metadata.Settings.FooterText) > 200 || (body.ThumbnailID != "" && !validID(body.ThumbnailID)) {
		h.error(w, ErrInvalid)
		return
	}
	if body.ThumbnailID != "" && !slices.Contains(refs, body.ThumbnailID) {
		refs = append(refs, body.ThumbnailID)
	}
	if body.ResultID != "" {
		if kind != "project" || !validID(body.ResultID) {
			h.error(w, ErrInvalid)
			return
		}
		asset, assetErr := h.store.Asset(r.Context(), body.ResultID)
		if errors.Is(assetErr, ErrNotFound) || (assetErr == nil && asset.MIME != "image/png") {
			h.error(w, ErrInvalid)
			return
		}
		if assetErr != nil {
			h.error(w, assetErr)
			return
		}
		if !slices.Contains(refs, body.ResultID) {
			refs = append(refs, body.ResultID)
		}
	}
	id := r.PathValue("id")
	status := 200
	if !update {
		id, err = randomID(16)
		status = 201
	} else if !validID(id) {
		err = ErrNotFound
	}
	if err != nil {
		h.error(w, err)
		return
	}
	doc, err := h.store.Save(r.Context(), Document{ID: id, Kind: kind, Name: body.Name, Number: metadata.Settings.FooterText, ThumbnailID: body.ThumbnailID, ResultID: body.ResultID, Snapshot: body.Snapshot, UpdatedAt: time.Now().UTC()}, refs, body.Version)
	if err != nil {
		h.error(w, err)
		return
	}
	h.reply(w, status, doc)
}
func (h *handler) remove(w http.ResponseWriter, r *http.Request, kind string) {
	var body struct {
		Version int64 `json:"version"`
	}
	id := r.PathValue("id")
	if !validID(id) || decode(w, r, &body, 4096) != nil || body.Version < 1 {
		h.error(w, ErrInvalid)
		return
	}
	if err := h.store.Delete(r.Context(), kind, id, body.Version); err != nil {
		h.error(w, err)
		return
	}
	h.reply(w, 200, nil)
}
func (h *handler) download(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		h.error(w, ErrNotFound)
		return
	}
	asset, err := h.store.Asset(r.Context(), id)
	if err != nil {
		h.error(w, err)
		return
	}
	f, err := os.Open(filepath.Join(h.opts.DataDir, id))
	if err != nil {
		h.error(w, err)
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		h.error(w, err)
		return
	}
	w.Header().Set("Content-Type", asset.MIME)
	w.Header().Set("Content-Disposition", `inline; filename="`+id+`"`)
	http.ServeContent(w, r, id, stat.ModTime(), f)
}
