package vagaga

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode"
)

const maxJSONBody = 512 * 1024

type authDevices map[[32]byte]Device

func parseDevices(raw string) (authDevices, error) {
	var entries []struct {
		Device
		TokenSHA256 string `json:"tokenSha256"`
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entries); err != nil || len(entries) == 0 || decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("PAIDAN_DEVICES_JSON must be a nonempty device array")
	}
	devices := make(authDevices, len(entries))
	ids := make(map[[2]string]bool, len(entries))
	for _, entry := range entries {
		digest, err := hex.DecodeString(entry.TokenSHA256)
		if err != nil || len(digest) != sha256.Size || !opaqueID.MatchString(entry.ID) || !opaqueID.MatchString(entry.Workspace) {
			return nil, errors.New("PAIDAN_DEVICES_JSON contains an invalid device id, workspace id, or SHA-256 digest")
		}
		switch entry.Role {
		case roleCustomer, roleProduction, roleBoth:
		default:
			return nil, errors.New("PAIDAN_DEVICES_JSON contains an invalid role")
		}
		deviceKey := [2]string{entry.Workspace, entry.ID}
		tokenKey := [32]byte(digest)
		if _, duplicate := devices[tokenKey]; duplicate || ids[deviceKey] {
			return nil, errors.New("PAIDAN_DEVICES_JSON contains duplicate credentials or device identity")
		}
		devices[tokenKey] = entry.Device
		ids[deviceKey] = true
	}
	return devices, nil
}

func (devices authDevices) authenticate(r *http.Request) (Device, bool) {
	headers := r.Header.Values("Authorization")
	if len(headers) != 1 {
		return Device{}, false
	}
	scheme, token, ok := strings.Cut(headers[0], " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" || strings.IndexFunc(token, unicode.IsSpace) >= 0 {
		return Device{}, false
	}
	device, ok := devices[sha256.Sum256([]byte(token))]
	return device, ok
}

type handler struct {
	repo     repository
	objects  objectStore
	maxBytes int64
	bucket   string
}

type endpoint func(http.ResponseWriter, *http.Request, Device)

func newHandler(devices authDevices, repo repository, objects objectStore, maxBytes int64, bucket string) http.Handler {
	h := handler{repo: repo, objects: objects, maxBytes: maxBytes, bucket: bucket}
	mux := http.NewServeMux()
	route := func(path string, methods map[string]endpoint) {
		mux.HandleFunc(Prefix+path, func(w http.ResponseWriter, r *http.Request) {
			device, ok := devices.authenticate(r)
			if !ok {
				w.Header().Set("WWW-Authenticate", "Bearer")
				fail(w, http.StatusUnauthorized, "unauthorized", "a valid device bearer token is required")
				return
			}
			serve, ok := methods[r.Method]
			if !ok {
				fail(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
				return
			}
			serve(w, r, device)
		})
	}
	if mysql, ok := repo.(mysqlRepository); ok {
		registerWorkflow(route, h, mysql.db)
	}
	materials := map[string]endpoint{
		"GET": h.sharedMaterialDownload, "POST": h.sharedMaterialUpload,
	}
	route("/shared-materials/{kind}/{name}", materials)
	route("/shared-materials/{order}/{kind}/{name}", materials)
	route("/device", map[string]endpoint{"GET": h.device})
	route("/upload-sessions", map[string]endpoint{"POST": h.createSession})
	route("/upload-sessions/{id}/complete", map[string]endpoint{"POST": h.completeSession})
	route("/orders", map[string]endpoint{"GET": h.listOrders})
	route("/orders/{number}", map[string]endpoint{"GET": h.getOrder, "DELETE": h.mutateOrder(deleteOrder)})
	route("/assets/{id}/download-url", map[string]endpoint{"POST": h.downloadURL})
	route("/orders/{number}/images/{id}/templates", map[string]endpoint{"PATCH": h.mutateOrder(editTemplates)})
	route("/orders/{number}/images/{id}", map[string]endpoint{"DELETE": h.mutateOrder(deleteImage)})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { respondError(w, errNotFound) })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}

func Unavailable(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	fail(w, http.StatusServiceUnavailable, "paidan_unavailable", "paidan synchronization is unavailable")
}

func (h handler) device(w http.ResponseWriter, r *http.Request, device Device) {
	if err := h.repo.ready(r.Context()); err != nil {
		fail(w, http.StatusServiceUnavailable, "database_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Device
		MaxFileBytes int64 `json:"maxFileBytes"`
	}{device, h.maxBytes})
}

func (h handler) createSession(w http.ResponseWriter, r *http.Request, device Device) {
	var input uploadInput
	if !decode(w, r, &input) {
		return
	}
	if !input.validate(h.maxBytes) {
		respondError(w, errInvalid)
		return
	}
	if !device.canUpload(input.Kind) {
		fail(w, http.StatusForbidden, "forbidden", "device role cannot upload this asset type")
		return
	}
	id, err := newID()
	if err != nil {
		respondError(w, err)
		return
	}
	key := "paidan/v1/" + device.Workspace + "/" + input.Kind + "s/" + input.AssetID + "." + imageExtensions[input.MIME]
	session, err := h.repo.createSession(r.Context(), device, storedSession{
		ID: id, Key: key, Bucket: h.bucket, Fingerprint: fingerprint(input), Input: input,
	})
	if err != nil {
		respondError(w, err)
		return
	}
	result := uploadSession{ID: session.ID, Key: session.Key, Version: session.Version, Completed: session.Version > 0}
	if !result.Completed {
		if session.Bucket != h.bucket {
			respondError(w, errUpstream)
			return
		}
		result.UploadURL, result.Token = h.objects.upload(session.Key, session.Input)
	}
	writeJSON(w, http.StatusOK, result)
}

func (h handler) completeSession(w http.ResponseWriter, r *http.Request, device Device) {
	id := r.PathValue("id")
	if !validHex(id, 32) {
		respondError(w, errInvalid)
		return
	}
	session, err := h.repo.getSession(r.Context(), device, id)
	if err != nil {
		respondError(w, err)
		return
	}
	if !device.canUpload(session.Input.Kind) {
		fail(w, http.StatusForbidden, "forbidden", "device role cannot upload this asset type")
		return
	}
	if session.Version > 0 {
		respondVersion(w, session.Version, nil)
		return
	}
	if session.Bucket != h.bucket {
		respondError(w, errUpstream)
		return
	}
	object, err := h.objects.stat(r.Context(), session.Key)
	if err != nil {
		respondError(w, err)
		return
	}
	if object.Size != session.Input.ByteLength || object.ETag != session.Input.ETag {
		respondError(w, errUploadMismatch)
		return
	}
	version, err := h.repo.completeSession(r.Context(), device, session)
	respondVersion(w, version, err)
}

func (h handler) listOrders(w http.ResponseWriter, r *http.Request, device Device) {
	query := r.URL.Query()
	after := query.Get("after")
	limit := 100
	if raw := query.Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			respondError(w, errInvalid)
			return
		}
	}
	if after != "" && !validOrderNumber(after) {
		respondError(w, errInvalid)
		return
	}
	orders, err := h.repo.listOrders(r.Context(), device, after, limit)
	if err != nil {
		respondError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, orders)
}

func (h handler) getOrder(w http.ResponseWriter, r *http.Request, device Device) {
	orderNumber := r.PathValue("number")
	if !validOrderNumber(orderNumber) {
		respondError(w, errInvalid)
		return
	}
	order, err := h.repo.getOrder(r.Context(), device, orderNumber)
	if err != nil {
		respondError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, order)
}

func (h handler) downloadURL(w http.ResponseWriter, r *http.Request, device Device) {
	id := r.PathValue("id")
	if !validHex(id, 32) {
		respondError(w, errInvalid)
		return
	}
	bucket, key, err := h.repo.assetKey(r.Context(), device, id)
	if err != nil {
		respondError(w, err)
		return
	}
	if bucket != h.bucket {
		respondError(w, errUpstream)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": h.objects.download(key)})
}

func (h handler) mutateOrder(kind string) endpoint {
	return func(w http.ResponseWriter, r *http.Request, device Device) {
		if kind != editTemplates && device.Role == roleProduction {
			fail(w, http.StatusForbidden, "forbidden", "device role cannot delete orders or images")
			return
		}
		var input mutation
		if !decode(w, r, &input) {
			return
		}
		input.Kind = kind
		input.OrderNumber = r.PathValue("number")
		input.AssetID = r.PathValue("id")
		if !validOrderNumber(input.OrderNumber) || (kind != deleteOrder && !validHex(input.AssetID, 32)) ||
			input.ExpectedVersion <= 0 || !validHex(input.RequestID, 32) {
			respondError(w, errInvalid)
			return
		}
		if kind == editTemplates {
			var valid bool
			input.Templates, valid = normalizeTemplates(input.Templates)
			if !valid {
				respondError(w, errInvalid)
				return
			}
		} else if input.Templates != nil {
			respondError(w, errInvalid)
			return
		}
		version, err := h.repo.mutate(r.Context(), device, input)
		respondVersion(w, version, err)
	}
}

func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil || decoder.Decode(new(any)) != io.EOF {
		respondError(w, errInvalid)
		return false
	}
	return true
}

func respondVersion(w http.ResponseWriter, version int64, err error) {
	if err != nil {
		respondError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"version": version})
}

func respondError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInvalid):
		fail(w, http.StatusBadRequest, "invalid_request", errInvalid.Error())
	case errors.Is(err, errNotFound):
		fail(w, http.StatusNotFound, "not_found", errNotFound.Error())
	case errors.Is(err, errStale):
		fail(w, http.StatusConflict, "stale_version", errStale.Error())
	case errors.Is(err, errConflict):
		fail(w, http.StatusConflict, "conflict", errConflict.Error())
	case errors.Is(err, errUploadMismatch):
		fail(w, http.StatusConflict, "upload_mismatch", errUploadMismatch.Error())
	case errors.Is(err, errObjectMissing):
		fail(w, http.StatusConflict, "upload_missing", errObjectMissing.Error())
	case errors.Is(err, errUpstream):
		fail(w, http.StatusServiceUnavailable, "storage_unavailable", errUpstream.Error())
	default:
		fail(w, http.StatusInternalServerError, "internal_error", "could not process the synchronization request")
	}
}

func fail(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
