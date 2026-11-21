package vagaga

import (
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

const workflowManifestLimit = 4 << 20

type workflowBlob struct {
	Size int64  `json:"bytes"`
	ETag string `json:"etag"`
}

type workflowAsset struct {
	ID        string     `json:"id"`
	SHA       string     `json:"sha256"`
	Size      int64      `json:"bytes"`
	Kind      string     `json:"kind"`
	Name      *string    `json:"name"`
	ImageID   *string    `json:"imageId,omitempty"`
	Width     *uint32    `json:"width,omitempty"`
	Height    *uint32    `json:"height,omitempty"`
	Templates []template `json:"templates,omitempty"`
}

type workflowManifest struct {
	Schema         int                        `json:"schemaVersion"`
	Order          string                     `json:"orderNumber"`
	Revision       int64                      `json:"revision"`
	Operation      string                     `json:"operationId"`
	State          string                     `json:"state"`
	Assets         []workflowAsset            `json:"assets"`
	Metadata       map[string]json.RawMessage `json:"metadata"`
	UpdatedAt      string                     `json:"updatedAt"`
	CompletedAt    *string                    `json:"completedAt,omitempty"`
	LocalCompleted *bool                      `json:"localCompleted"`
}

func workflowKey(workspace, digest, etag string) string {
	return "paidan/v2/" + workspace + "/objects/" + digest + "/" + etag
}

func workflowDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// The manifest size limit is one Kodo ETag block.
func manifestETag(data []byte) string {
	sum := sha1.Sum(data)
	return base64.URLEncoding.EncodeToString(append([]byte{0x16}, sum[:]...))
}

func registerWorkflow(route func(string, map[string]endpoint), h handler, db *sql.DB) {
	api := workflowAPI{handler: h, db: db}
	route("/workflow-v2/blobs/{id}", map[string]endpoint{"POST": api.stage, "GET": api.blobURL})
	route("/workflow-v2/blobs/{id}/verify", map[string]endpoint{"POST": api.verify})
	for _, collection := range []string{"orders", "backups"} {
		route("/workflow-v2/"+collection, map[string]endpoint{"GET": api.list(collection)})
		route("/workflow-v2/"+collection+"/{id}", map[string]endpoint{"GET": api.latest(collection), "PUT": api.commit(collection)})
	}
}

type workflowAPI struct {
	handler
	db *sql.DB
}

func (api workflowAPI) blobInput(w http.ResponseWriter, r *http.Request) (workflowBlob, bool) {
	var in workflowBlob
	if !decode(w, r, &in) {
		return in, false
	}
	if !validHex(r.PathValue("id"), 64) || in.Size <= 0 || in.Size > api.maxBytes || !qiniuETag.MatchString(in.ETag) {
		respondError(w, errInvalid)
		return in, false
	}
	return in, true
}

func (api workflowAPI) stage(w http.ResponseWriter, r *http.Request, d Device) {
	in, ok := api.blobInput(w, r)
	if !ok {
		return
	}
	digest := r.PathValue("id")
	key := workflowKey(d.Workspace, digest, in.ETag)
	var existing workflowBlob
	err := api.db.QueryRowContext(r.Context(), "SELECT byte_length,etag FROM paidan_workflow_blobs WHERE workspace_id=? AND bucket=? AND digest=?", d.Workspace, api.bucket, digest).Scan(&existing.Size, &existing.ETag)
	if err == nil {
		if existing != in {
			respondError(w, errUploadMismatch)
			return
		}
		writeJSON(w, 200, uploadSession{Completed: true})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		respondError(w, err)
		return
	}
	url, token := api.objects.upload(key, uploadInput{ByteLength: in.Size, MIME: "application/octet-stream"})
	writeJSON(w, 200, uploadSession{ID: digest, Key: key, UploadURL: url, Token: token})
}

func (api workflowAPI) verify(w http.ResponseWriter, r *http.Request, d Device) {
	in, ok := api.blobInput(w, r)
	if !ok {
		return
	}
	digest := r.PathValue("id")
	stat, err := api.objects.stat(r.Context(), workflowKey(d.Workspace, digest, in.ETag))
	if err != nil {
		respondError(w, err)
		return
	}
	if stat.Size != in.Size || stat.ETag != in.ETag {
		respondError(w, errUploadMismatch)
		return
	}
	ctx := r.Context()
	_, err = api.db.ExecContext(ctx, "INSERT INTO paidan_workflow_blobs(workspace_id,bucket,digest,byte_length,etag) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE digest=VALUES(digest)", d.Workspace, api.bucket, digest, in.Size, in.ETag)
	if err == nil {
		var saved workflowBlob
		err = api.db.QueryRowContext(ctx, "SELECT byte_length,etag FROM paidan_workflow_blobs WHERE workspace_id=? AND bucket=? AND digest=?", d.Workspace, api.bucket, digest).Scan(&saved.Size, &saved.ETag)
		if err == nil && saved != in {
			err = errUploadMismatch
		}
	}
	if err != nil {
		respondError(w, err)
		return
	}
	writeJSON(w, 200, true)
}

func (api workflowAPI) signed(w http.ResponseWriter, r *http.Request, d Device, digest string) {
	var blob workflowBlob
	err := api.db.QueryRowContext(r.Context(), "SELECT byte_length,etag FROM paidan_workflow_blobs WHERE workspace_id=? AND bucket=? AND digest=? AND published=TRUE", d.Workspace, api.bucket, digest).Scan(&blob.Size, &blob.ETag)
	if err != nil {
		respondError(w, rowError(err))
		return
	}
	writeJSON(w, 200, map[string]any{"sha256": digest, "bytes": blob.Size, "url": api.objects.download(workflowKey(d.Workspace, digest, blob.ETag))})
}

func (api workflowAPI) blobURL(w http.ResponseWriter, r *http.Request, d Device) {
	id := r.PathValue("id")
	if !validHex(id, 64) {
		respondError(w, errInvalid)
		return
	}
	api.signed(w, r, d, id)
}

func workflowID(collection, id string) bool {
	if collection == "backups" {
		return validHex(id, 32)
	}
	return validHex(id, 64)
}

func (api workflowAPI) list(collection string) endpoint {
	return func(w http.ResponseWriter, r *http.Request, d Device) {
		after := r.URL.Query().Get("after")
		if after != "" && !workflowID(collection, after) {
			respondError(w, errInvalid)
			return
		}
		rows, err := api.db.QueryContext(r.Context(), "SELECT item_id FROM paidan_workflow_heads WHERE workspace_id=? AND bucket=? AND collection=? AND item_id>? AND digest<>'' ORDER BY item_id LIMIT 100", d.Workspace, api.bucket, collection, after)
		if err != nil {
			respondError(w, err)
			return
		}
		defer rows.Close()
		ids := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				respondError(w, err)
				return
			}
			ids = append(ids, id)
		}
		if err = rows.Err(); err != nil {
			respondError(w, err)
			return
		}
		writeJSON(w, 200, ids)
	}
}

func (api workflowAPI) latest(collection string) endpoint {
	return func(w http.ResponseWriter, r *http.Request, d Device) {
		id := r.PathValue("id")
		if !workflowID(collection, id) {
			respondError(w, errInvalid)
			return
		}
		var digest string
		err := api.db.QueryRowContext(r.Context(), "SELECT digest FROM paidan_workflow_heads WHERE workspace_id=? AND bucket=? AND collection=? AND item_id=? AND digest<>''", d.Workspace, api.bucket, collection, id).Scan(&digest)
		if err != nil {
			respondError(w, rowError(err))
			return
		}
		api.signed(w, r, d, digest)
	}
}

func (m workflowManifest) valid(collection, id string, expected int64) bool {
	if m.Schema != 1 || strings.TrimSpace(m.Order) == "" || len(m.Order) > 256 || !validHex(m.Operation, 32) || (m.State != "pending" && m.State != "completed") || m.Assets == nil || m.LocalCompleted == nil || m.UpdatedAt == "" {
		return false
	}
	ids := make(map[string]bool, len(m.Assets))
	hasProduction := false
	for _, asset := range m.Assets {
		if !validHex(asset.ID, 32) || ids[asset.ID] || asset.Name == nil || !validHex(asset.SHA, 64) || asset.Size <= 0 || asset.Size > defaultFileLimit || (asset.Kind != kindOriginal && asset.Kind != kindProduction) {
			return false
		}
		ids[asset.ID] = true
		hasProduction = hasProduction || asset.Kind == kindProduction
	}
	if collection == "backups" {
		return m.Revision == 0
	}
	if m.State == "pending" && (len(m.Assets) == 0 || hasProduction) {
		return false
	}
	return workflowDigest([]byte(m.Order)) == id && expected >= 0 && m.Revision > 0 && m.Revision-1 == expected
}

func (api workflowAPI) commit(collection string) endpoint {
	return func(w http.ResponseWriter, r *http.Request, d Device) {
		id := r.PathValue("id")
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, workflowManifestLimit))
		var m workflowManifest
		var expected int64
		if err == nil && collection == "orders" {
			expected, err = strconv.ParseInt(r.URL.Query().Get("expected"), 10, 64)
		}
		if err != nil || !workflowID(collection, id) || json.Unmarshal(data, &m) != nil || !m.valid(collection, id, expected) {
			respondError(w, errInvalid)
			return
		}
		if collection == "orders" && ((m.State == "completed" && !d.canUpload(kindProduction)) || (m.State == "pending" && !d.canUpload(kindOriginal))) {
			fail(w, 403, "forbidden", "device role cannot publish this state")
			return
		}
		err = api.publish(r.Context(), d, collection, id, expected, data, m)
		if errors.Is(err, errStale) {
			writeJSON(w, 200, false)
			return
		}
		if err != nil {
			respondError(w, err)
			return
		}
		writeJSON(w, 200, true)
	}
}
