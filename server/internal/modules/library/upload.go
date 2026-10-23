package library

import (
	"bytes"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

const maxImageBytes = 25 << 20

func (h *handler) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImageBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		if r.MultipartForm != nil {
			r.MultipartForm.RemoveAll()
		}
		h.fail(w, 413, "图片过大（单张最多 25 MB）或上传无效")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, _, err := r.FormFile("file")
	if err != nil {
		h.error(w, ErrInvalid)
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxImageBytes+1))
	if err != nil {
		h.error(w, err)
		return
	}
	if len(data) > maxImageBytes {
		h.fail(w, 413, "单张图片最多 25 MB")
		return
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 40e6 {
		h.fail(w, 400, "请选择 PNG、JPEG 或 GIF 图片（最多 4000 万像素），其他格式请先转为 PNG")
		return
	}
	mime := map[string]string{"png": "image/png", "jpeg": "image/jpeg", "gif": "image/gif"}[format]
	if mime == "" {
		h.error(w, ErrInvalid)
		return
	}
	id, err := randomID(16)
	if err != nil {
		h.error(w, err)
		return
	}
	path := filepath.Join(h.opts.DataDir, id)
	dest, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		h.error(w, err)
		return
	}
	if _, err = dest.Write(data); err == nil {
		err = dest.Sync()
	}
	closeErr := dest.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(path)
		h.error(w, err)
		return
	}
	asset := Asset{ID: id, MIME: mime, Size: int64(len(data)), Width: cfg.Width, Height: cfg.Height}
	if err = h.store.CreateAsset(r.Context(), asset); err != nil {
		os.Remove(path)
		h.error(w, err)
		return
	}
	h.reply(w, 201, asset)
}
