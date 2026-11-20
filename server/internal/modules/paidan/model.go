package paidan

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	Prefix           = "/api/v1/paidan"
	defaultFileLimit = 100 * 1024 * 1024
	kindOriginal     = "original"
	kindProduction   = "production"
	roleCustomer     = "customer"
	roleProduction   = "production"
	roleBoth         = "both"
	editTemplates    = "templates"
	deleteImage      = "delete_image"
	deleteOrder      = "delete_order"
)

var (
	errInvalid        = errors.New("invalid request")
	errNotFound       = errors.New("resource not found")
	errConflict       = errors.New("the request conflicts with existing data")
	errStale          = errors.New("the order version changed")
	errUploadMismatch = errors.New("the uploaded file does not match the session")
	errObjectMissing  = errors.New("the file is not in object storage yet")
	errUpstream       = errors.New("object storage is temporarily unavailable")
	opaqueID          = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	qiniuETag         = regexp.MustCompile(`^[A-Za-z0-9_-]{28}$`)
	imageExtensions   = map[string]string{
		"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
	}
)

type Device struct {
	ID        string `json:"deviceId"`
	Workspace string `json:"workspaceId"`
	Role      string `json:"role"`
}

func (d Device) canUpload(kind string) bool {
	return d.Role == roleBoth || (d.Role == roleCustomer && kind == kindOriginal) ||
		(d.Role == roleProduction && kind == kindProduction)
}

type template struct {
	ID       string `json:"templateId"`
	Quantity int64  `json:"quantity"`
}

func normalizeTemplates(templates []template) ([]template, bool) {
	if len(templates) > 512 {
		return nil, false
	}
	if len(templates) == 0 {
		return []template{}, true
	}
	slices.SortFunc(templates, func(a, b template) int { return strings.Compare(a.ID, b.ID) })
	for i, entry := range templates {
		if !validText(entry.ID, 255) || entry.Quantity <= 0 || (i > 0 && templates[i-1].ID == entry.ID) {
			return nil, false
		}
	}
	return templates, true
}

type uploadInput struct {
	RequestID     string     `json:"requestId"`
	AssetID       string     `json:"assetId"`
	Kind          string     `json:"kind"`
	OrderNumber   string     `json:"orderNumber"`
	FileName      string     `json:"fileName"`
	MIME          string     `json:"mime"`
	ByteLength    int64      `json:"byteLength"`
	Width         int32      `json:"width"`
	Height        int32      `json:"height"`
	SHA256        string     `json:"sha256"`
	ETag          string     `json:"etag"`
	Templates     []template `json:"templates"`
	SourceImageID string     `json:"sourceImageId,omitempty"`
	Metadata      string     `json:"metadata,omitempty"`
}

func (u *uploadInput) validate(maxBytes int64) bool {
	if !validHex(u.RequestID, 32) || !validHex(u.AssetID, 32) || !validHex(u.SHA256, 64) ||
		!qiniuETag.MatchString(u.ETag) || !validOrderNumber(u.OrderNumber) || !validFileName(u.FileName) ||
		imageExtensions[u.MIME] == "" || u.ByteLength <= 0 || u.ByteLength > maxBytes ||
		u.Width <= 0 || u.Height <= 0 || len(u.Metadata) > 16384 {
		return false
	}
	switch u.Kind {
	case kindOriginal:
		if u.SourceImageID != "" {
			return false
		}
	case kindProduction:
		if u.SourceImageID != "" && !validHex(u.SourceImageID, 32) {
			return false
		}
	default:
		return false
	}
	var valid bool
	u.Templates, valid = normalizeTemplates(u.Templates)
	return valid
}

func validHex(value string, digits int) bool {
	if len(value) != digits || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validText(value string, maxBytes int) bool {
	return len(value) > 0 && len(value) <= maxBytes && utf8.ValidString(value) &&
		strings.TrimSpace(value) != "" && strings.IndexFunc(value, unicode.IsControl) < 0
}

func validOrderNumber(value string) bool {
	return validText(value, 191) && !strings.ContainsAny(value, "/\\") && value != "." && value != ".."
}

func validFileName(value string) bool {
	return validText(value, 255) && !strings.ContainsAny(value, "/\\") && value != "." && value != ".."
}

type objectInfo struct {
	Size int64
	ETag string
}

type objectStore interface {
	upload(key string, input uploadInput) (endpoint string, token string)
	stat(ctx context.Context, key string) (objectInfo, error)
	download(key string) string
}

type storedSession struct {
	ID          string
	Key         string
	Bucket      string
	Version     int64
	Fingerprint [32]byte
	Input       uploadInput
}

type uploadSession struct {
	ID        string `json:"id"`
	Key       string `json:"key"`
	UploadURL string `json:"uploadUrl"`
	Token     string `json:"token"`
	Completed bool   `json:"completed"`
	Version   int64  `json:"version,omitempty"`
}

type orderSummary struct {
	Number  string `json:"orderNumber"`
	Version int64  `json:"version"`
	Deleted bool   `json:"deleted"`
}

type orderList struct {
	Orders []orderSummary `json:"orders"`
	Next   *string        `json:"next"`
}

type orderSnapshot struct {
	orderSummary
	Metadata string  `json:"metadata,omitempty"`
	Assets   []asset `json:"assets"`
}

type asset struct {
	ID            string     `json:"id"`
	Kind          string     `json:"kind"`
	FileName      string     `json:"fileName"`
	MIME          string     `json:"mime"`
	ByteLength    int64      `json:"byteLength"`
	Width         int32      `json:"width"`
	Height        int32      `json:"height"`
	SHA256        string     `json:"sha256"`
	ETag          string     `json:"etag"`
	Templates     []template `json:"templates"`
	SourceImageID string     `json:"sourceImageId,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	Deleted       bool       `json:"deleted"`
}

type mutation struct {
	ExpectedVersion int64      `json:"expectedVersion"`
	RequestID       string     `json:"requestId"`
	Templates       []template `json:"templates,omitempty"`
	Kind            string     `json:"-"`
	OrderNumber     string     `json:"-"`
	AssetID         string     `json:"-"`
}

type repository interface {
	ready(context.Context) error
	createSession(context.Context, Device, storedSession) (storedSession, error)
	getSession(context.Context, Device, string) (storedSession, error)
	completeSession(context.Context, Device, storedSession) (int64, error)
	listOrders(context.Context, Device, string, int) (orderList, error)
	getOrder(context.Context, Device, string) (orderSnapshot, error)
	assetKey(context.Context, Device, string) (bucket string, key string, err error)
	mutate(context.Context, Device, mutation) (int64, error)
}

func newID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(data[:]), nil
}

func fingerprint(value any) [32]byte {
	// Callers pass fixed structures containing only JSON-native values.
	data, _ := json.Marshal(value)
	return sha256.Sum256(data)
}
