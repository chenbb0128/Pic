package vagaga

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
)

var sharedImageTypes = map[string]string{
	"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "gif": "image/gif",
	"bmp": "image/bmp", "tif": "image/tiff", "ico": "image/vnd.microsoft.icon", "avif": "image/avif",
}

var sharedMaterialOrder = regexp.MustCompile(`^(?:[A-Za-z0-9_.-]{1,256}|~[A-Za-z0-9_-]{1,342})$`)

func sharedMaterialKey(r *http.Request, d Device) (string, string, bool) {
	kind, name := r.PathValue("kind"), r.PathValue("name")
	id, ext, _ := strings.Cut(name, ".")
	mime := sharedImageTypes[ext]
	if (kind != kindOriginal && kind != kindProduction) || !validHex(id, 32) || mime == "" {
		return "", "", false
	}
	prefix := "vagaga/materials/" + d.Workspace + "/"
	if order := r.PathValue("order"); order != "" {
		if order == "." || order == ".." || !sharedMaterialOrder.MatchString(order) {
			return "", "", false
		}
		prefix += order + "/"
	}
	return prefix + kind + "/" + name, mime, true
}

func (h handler) sharedMaterialUpload(w http.ResponseWriter, r *http.Request, d Device) {
	key, mime, ok := sharedMaterialKey(r, d)
	if !ok {
		respondError(w, errInvalid)
		return
	}
	if !d.canUpload(r.PathValue("kind")) {
		fail(w, http.StatusForbidden, "forbidden", "device role cannot upload this image")
		return
	}
	var in struct {
		Bytes int64 `json:"bytes"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Bytes <= 0 || in.Bytes > h.maxBytes {
		respondError(w, errInvalid)
		return
	}
	url, token := h.objects.upload(key, uploadInput{ByteLength: in.Bytes, MIME: mime})
	writeJSON(w, 200, uploadSession{Key: key, UploadURL: url, Token: token})
}

func (h handler) sharedMaterialDownload(w http.ResponseWriter, r *http.Request, d Device) {
	key, _, ok := sharedMaterialKey(r, d)
	if !ok {
		respondError(w, errInvalid)
		return
	}
	stat, err := h.objects.stat(r.Context(), key)
	if errors.Is(err, errObjectMissing) {
		respondError(w, errNotFound)
		return
	}
	if err != nil {
		respondError(w, err)
		return
	}
	if stat.Size <= 0 || stat.Size > h.maxBytes {
		respondError(w, errUploadMismatch)
		return
	}
	writeJSON(w, 200, map[string]any{"bytes": stat.Size, "url": h.objects.download(key)})
}
